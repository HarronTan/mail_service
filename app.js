"use strict";
import express from "express";
import { google } from "googleapis";
import bodyParser from "body-parser";
import "dotenv/config";
import { PubSub } from "@google-cloud/pubsub";
import { readFileSync } from "fs";
import webPush from "web-push";
import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { detectCategoryUsingAI } from "./gemini.js";

webPush.setVapidDetails(
  "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const supabaseUrl = "https://doqgomabmxpcijxoliff.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const serviceAccount = JSON.parse(
  readFileSync(new URL("./service-account.json", import.meta.url)),
);

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT;
const host = process.env.HOST;
const PROTOCOL = process.env.PROTOCOL;

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  `${PROTOCOL}://${host}/oauth2callback`,
);

async function getEmailFromAccessToken(access_token) {
  const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!resp.ok) throw new Error("Failed to fetch userinfo: " + resp.status);
  const profile = await resp.json();
  // profile.email, profile.email_verified, profile.sub, profile.name, profile.picture
  return profile;
}

const clients = new Map();

export function getOAuthClient(userID, tokens, isNew) {
  if (clients.has(userID) && !isNew) {
    return clients.get(userID);
  }

  const client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    `${PROTOCOL}://${host}/oauth2callback`,
  );

  client.setCredentials(tokens);

  client.on("tokens", async (newTokens) => {
    console.log("🔄 Token event fired for", userID);
    await safeUpdateTokens(userID, tokens, newTokens);
  });

  clients.set(userID, client);
  return client;
}

async function safeUpdateTokens(userID, oldTokens, newTokens) {
  const merged = { ...oldTokens };

  if (newTokens.access_token) {
    merged.access_token = newTokens.access_token;
    merged.expiry_date = newTokens.expiry_date;
  }

  if (newTokens.refresh_token) {
    merged.refresh_token = newTokens.refresh_token;
  }

  await updateOauthToken(userID, merged);
}

app.get("/healthcheck", (req, res) => {
  res.status(200).send();
});

// Step 1: Generate Auth URL
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "email",
      "profile",
    ],
  });
  res.redirect(url);
});

// Step 2: Handle OAuth2 callback
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oAuth2Client.getToken(code);
  const { access_token } = tokens;
  const profile = await getEmailFromAccessToken(access_token);
  const email = profile.email;

  //check user in db
  const user = await getUser(email);
  if (user == null) {
    res.send(`User is not registered.`);
    return;
  }

  const auth = await getOAuthClient(user.id, tokens, true);
  const gmail = google.gmail({ version: "v1", auth });

  const response = await gmail.users
    .watch({
      userId: "me",
      requestBody: {
        topicName: "projects/mail-service-470611/topics/gmail-updates",
        labelIds: ["INBOX"],
      },
    })
    .catch((err) => {
      return res.send(err);
    });
  const data = response.data;

  await updateLastHistoryId(user.id, data.historyId ?? "");
  await updateOauthToken(user.id, tokens);

  // userState.set(state,tokens)
  res.send(`User ${email} authenticated successfully!`);
});

app.get("/start-watch", async (req, res) => {
  const user = await getUser("harrontan@gmail.com");
  const tokens = await getUserToken(user.id);
  const auth = await createOAuthClient(user.id, tokens);
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: "projects/mail-service-470611/topics/gmail-updates",
      labelIds: ["INBOX"], // optional: only watch inbox
    },
  });
  res.json(response.data);
});

app.listen(port, () => {
  console.log(`Server running on ${PROTOCOL}://${host}:${port}`);
  startServer();
});

app.get("/test/send", async (req, res) => {
  await sendUserNotification(
    "56ab3477-86d3-4814-9ccc-7221ad1398ab",
    1.5,
    "test notification",
  );

  res.status(200).send();
});

// app.get("/test", async (req,res) => {
// })

async function retryWithBackoff(fn, maxRetries = 3, delayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(
        `[retry] Attempt ${attempt}/${maxRetries} failed:`,
        error.message,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt)); // Exponential backoff
      }
    }
  }
  throw lastError;
}

async function sendToDb(rawDescription, user_id) {
  const userCategoriesData = await getUserCategories(user_id);
  const categories =
    userCategoriesData == null
      ? null
      : userCategoriesData.length > 0
        ? userCategoriesData.map((d) => d.name).join()
        : null;

  let { amount, description, category } = await retryWithBackoff(
    async () => detectCategoryUsingAI(raswDescription, categories),
    3,
    1000, // 1 second delay between retries
  );

  const response = await fetch(
    "https://doqgomabmxpcijxoliff.supabase.co/functions/v1/add-expense",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: user_id,
        amount: amount,
        description: description,
        category_name: category,
        date: new Date().toISOString(),
      }),
    },
  );

  const data = await response.json();
  console.log(data);
  console.log(`Successfully added data to db!`);

  await sendUserNotification(user_id, amount, description);
}

function getBody(payload) {
  let body = "";
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf-8");
        break;
      } else if (part.mimeType === "text/html" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.parts) {
        // Recursive for nested parts
        body = getBody(part);
      }
    }
  } else if (payload.body?.data) {
    body = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return body;
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  return $("body").text().replace(/\s+/g, " ").trim(); // collapse whitespace
}

async function sendUserCustomNotification(userId, title, message) {
  let { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId);

  if (data.length != 1) return;

  data = data[0];
  const subscription = {
    endpoint: data.endpoint,
    keys: {
      p256dh: data.p256dh,
      auth: data.auth,
    },
  };

  const payload = JSON.stringify({
    title: title,
    body: message,
    icon: "/icons/notification.png",
    // url: "https://your-app.com/expenses"
  });

  await sendNotification(subscription, payload);
}

async function sendUserNotification(userId, amount, desc) {
  let { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId);

  if (data.length != 1) return;

  data = data[0];
  const subscription = {
    endpoint: data.endpoint,
    keys: {
      p256dh: data.p256dh,
      auth: data.auth,
    },
  };

  const payload = JSON.stringify({
    title: "New Transaction",
    body: `You spent ${amount} at ${desc}`,
    icon: "/icons/notification.png",
    // url: "https://your-app.com/expenses"
  });

  await sendNotification(subscription, payload);
}

async function sendNotification(subscription, payload) {
  try {
    await webPush.sendNotification(subscription, payload);
    console.log("✅ Push notification sent!");
  } catch (err) {
    console.error("❌ Error sending push:", err);
  }
}

async function getUser(email) {
  if (email === "jingwenmvp@gmail.com") {
    email = "jing_wen@live.com";
  }
  const { data, error } = await supabase.auth.admin.listUsers({
    limit: 1000, // optional: max 1000 at a time
  });

  if (error) {
    console.error(error);
    return null;
  }

  const user = data.users.find((u) => u.email === email);

  if (!user) {
    console.log("no user found.");
    null;
  } else {
    return {
      id: user.id,
      email: user.email,
    };
  }
}

async function getUserToken(userID) {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("*")
    .eq("user_id", userID)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no row found
    throw error;
  }

  return data;
}

async function getUserTokenlist() {
  const { data, error } = await supabase.from("oauth_tokens").select("*");

  if (error) {
    return null;
  }
  return data;
}

export async function getUserCategories(userID) {
  const { data, error } = await supabase
    .from("categories")
    .select("name")
    .eq("user_id", userID);

  if (error) {
    console.log(error);
    return null;
  }

  return data;
}

async function delUserToken(userID) {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .delete()
    .eq("user_id", userID)
    .select(); // return deleted rows

  if (error) {
    throw error;
  }

  return data; // deleted rows
}

async function updateOauthToken(user_id, tokens) {
  await supabase.from("oauth_tokens").upsert({
    user_id,
    provider: "google",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    updated_at: new Date().toISOString(),
  });
}

async function getLastHistoryId(userID) {
  const { data, error } = await supabase
    .from("last_history_id")
    .select("history_id")
    .eq("user_id", userID)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // no row found
    throw error;
  }

  return data.history_id;
}
async function updateLastHistoryId(user_id, history_id) {
  await supabase.from("last_history_id").upsert({
    user_id,
    history_id,
    updated_at: new Date().toISOString(),
  });
}

async function validatingAuthclients() {
  const authList = await getUserTokenlist();
  if (authList == null) return;

  for (const auth_token of authList) {
    await getOAuthClient(auth_token.user_id, auth_token, false);
  }
}

async function startServer() {
  console.log("Starting server....");
  const pubsub = new PubSub({
    projectId: "mail-service-470611",
    credentials: serviceAccount,
  });
  const subscription = pubsub.subscription("gmail-updates-sub");
  const processedMessageIds = new Set();
  await validatingAuthclients();

  console.log("start subscribing!");
  subscription.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.data.toString());
      console.log("📩 Gmail update:", data);

      const user = await getUser(data.emailAddress);
      if (user == null) return;
      const userID = user.id;
      const tokens = await getUserToken(userID);
      if (tokens == null) return;
      const auth = await getOAuthClient(userID, tokens, false);

      const gmail = google.gmail({ version: "v1", auth });
      const lastHistoryId = await getLastHistoryId(userID);
      if (lastHistoryId == null) return;

      const historyRes = await gmail.users.history
        .list({
          userId: "me",
          startHistoryId: lastHistoryId,
        })
        .catch((err) => {
          err.userID = userID;
          throw err;
        });
      const newLastHistoryId = historyRes.data.historyId || lastHistoryId;
      await updateLastHistoryId(userID, newLastHistoryId);

      const history = historyRes.data.history || [];

      for (const record of history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            const messageId = added.message.id;
            if (processedMessageIds.has(messageId)) continue;
            processedMessageIds.add(messageId);
            let message;
            try {
              message = await gmail.users.messages.get({
                userId: "me",
                id: messageId,
              });
            } catch (err) {
              console.error(`Error fetching message ${messageId}`);
              console.error(JSON.stringify(err));
              continue; // skip this message and continue with next
            }

            const snippet = message.data.snippet;
            const internalDate = parseInt(message.data.internalDate);

            // Only process if received AFTER we started
            if (internalDate > Date.now() - 60 * 1000) {
              const rawBody = getBody(message.data.payload);
              const cleanText = /<[^>]+>/.test(rawBody)
                ? htmlToText(rawBody)
                : rawBody;
              if (cleanText.includes("You have received")) {
                console.log("Skipping received case!");
                continue;
              }
              const regexs = [
                /Amount:\s*SGD\s*([\d.,]+).*?To:\s*(.*?)NETS/i, // NETS
                /made to\s+(.+?)\s+using.*?Amount\s*:\s*SGD\s*([\d,]+\.\d{2})/s, // OCBC Paynow
                /SGD\s*([\d,]+\.\d{2}).*at\s+(?:.*\s)?at\s+([^\.\n]+)\./i, // OCBC CC
                /\+?SGD\s*([\d,]+\.\d{2}).*at\s+([^\.]+)\./i, // SC CC
                /Amount\s*:?\s*SGD\s*([\d,]+\.\d{2})[\s\S]*?To\s*:?\s*([^\n]+?)(?=\n|if unauthorised)/i, // DBS Paynow
                /Transaction Amount\s+([A-Z]{3}\d+(?:\.\d+)?)\s+Description\s+(.+)/, // HSBC
              ];

              let ind = 0;
              for (const regex of regexs) {
                const match = cleanText.match(regex);
                if (match) {
                  await sendToDb(cleanText, userID);
                  break;
                }
                ind += 1;
              }
            }
          }
        }
      }

      processedMessageIds.clear();
      msg.ack();
    } catch (err) {
      const errStr = err?.message || JSON.stringify(err);
      const knownErrors = [
        "Request had invalid authentication credentials.",
        "invalid_grant",
        "Request had insufficient authentication scopes",
      ];
      if (knownErrors.some((e) => errStr.includes(e))) {
        await delUserToken(err.userID);
        clients.delete(err.userID);
        await sendUserCustomNotification(
          err.userID,
          "Token Expired",
          "Please reauthenticate!",
        );
      } else {
        console.error("❌ Error handling message:", err);
      }
    }
  });

  subscription.on("error", (err) => {
    console.error("❌ Subscription error:", err);
  });
}

// Homepage route

app.get("/", async (req, res) => {
  // Updated HTML content with navigation links to privacy and terms pages
  res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Email Transaction Monitor</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                h1 { color: #333; margin-bottom: 20px; }
                p { color: #666; font-size: 1.2em; line-height: 1.6; }
                nav { margin-top: 30px; }
                a { color: #2c7a4d; text-decoration: none; margin: 0 15px; font-size: 1.1em; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <h1>Email Transaction Monitor</h1>
            <p>Welcome to the transaction monitoring application.</p>
            <p>Status: Running & Monitoring...</p>
            
            <nav>
                <a href="/privacy">Privacy Policy</a>
                <a href="/terms">Terms of Service</a>
            </nav>
        </body>
        </html>
    `);
});

app.get("/privacy", async (req, res) => {
  // Privacy policy HTML content
  const privacyContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Privacy Policy - Email Transaction Monitor</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    margin: 0 auto; 
                    padding: 50px; 
                    max-width: 800px;
                    color: #333;
                }
                h1 { color: #2c7a4d; }
                p { line-height: 1.6; color: #555; }
            </style>
        </head>
        <body>
            <h1>Privacy Policy</h1>
            <p>Welcome to the Email Transaction Monitor application.</p>
            
            <p><strong>Data Collection:</strong></p>
            <p>We collect email data only when you have explicitly authorized our Gmail Watch subscription. This data is used solely for detecting financial transactions from supported banks (NETS, OCBC, DBS, HSBC, SC).</p>
            
            <p><strong>Data Usage:</strong></p>
            <p>All transaction information is processed to categorize expenses and send push notifications. We do not store your email content beyond the current session except for logged transactions in our Supabase database.</p>
            
            <p><strong>Third-Party Services:</strong></p>
            <p>We use Google Cloud API, Supabase, and Web Push services to power our transaction monitoring capabilities. These services are used only with your explicit authorization.</p>
            
            <p><strong>Data Security:</strong></p>
            <p>We implement token refresh mechanisms to maintain service stability without interrupting your email monitoring. Your OAuth tokens are securely stored in Supabase.</p>
            
            <p><strong>Contact:</strong></p>
            <p>For privacy concerns, please contact harrontan@gmail.com.</p>
            
            <p>Last updated: ${new Date().toLocaleDateString()}</p>
        </body>
        </html>
    `;

  res.send(privacyContent);
});

app.get("/terms", async (req, res) => {
  // Terms of Service HTML content
  const termsContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Terms of Service - Email Transaction Monitor</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    margin: 0 auto; 
                    padding: 50px; 
                    max-width: 800px;
                    color: #333;
                }
                h1 { color: #2c7a4d; }
                p { line-height: 1.6; color: #555; }
                ul { line-height: 1.6; }
            </style>
        </head>
        <body>
            <h1>Terms of Service</h1>
            
            <p><strong>Acceptance of Terms:</strong></p>
            <p>By using the Email Transaction Monitor application, you agree to be bound by these terms.</p>
            
            <p><strong>Authorization Requirements:</strong></p>
            <ul>
                <li>You must explicitly authorize our Gmail Watch subscription through Google's OAuth flow.</li>
                <li>You are responsible for managing your authorization tokens and refresh cycles.</li>
                <li>We will not store more than the last known history ID to avoid re-processing historical emails.</li>
            </ul>
            
            <p><strong>Service Availability:</strong></p>
            <ul>
                <li>The application provides transaction monitoring for supported banks (NETS, OCBC, DBS, HSBC, SC).</li>
                <li>We use token refresh mechanisms to maintain service stability and prevent interruptions.</li>
                <li>Third-party services (Google Cloud API, Supabase, Web Push) are used only with your explicit authorization.</li>
            </ul>
            
            <p><strong>Data Privacy:</strong></p>
            <ul>
                <li>We collect email data only when you have explicitly authorized our Gmail Watch subscription.</li>
                <li>All transaction information is processed to categorize expenses and send push notifications.</li>
                <li>We do not store your email content beyond the current session except for logged transactions in Supabase database.</li>
            </ul>
            
            <p><strong>Token Management:</strong></p>
            <ul>
                <li>We implement automatic token refresh to maintain service stability.</li>
                <li>If token refresh fails, we will notify you and request manual re-authentication.</li>
                <li>Your OAuth tokens are securely stored in Supabase with proper authorization controls.</li>
            </ul>
            
            <p><strong>Third-Party Services:</strong></p>
            <ul>
                <li>We use Google Cloud API, Supabase, and Web Push services to power our transaction monitoring capabilities.</li>
                <li>These services are used only with your explicit authorization and in compliance with their terms of service.</li>
            </ul>
            
            <p><strong>Data Security:</strong></p>
            <ul>
                <li>We implement proper token expiration handling to maintain production stability.</li>
                <li>All Supabase queries include user_id for authorization.</li>
                <li>Client secrets and OAuth credentials are never exposed in logs.</li>
            </ul>
            
            <p><strong>Modification of Terms:</strong></p>
            <p>We reserve the right to modify these terms at any time. Your continued use of the application constitutes acceptance of modified terms.</p>
            
            <p><strong>Contact Information:</strong></p>
            <p>For terms-related concerns, please contact harrontan@gmail.com.</p>
            
            <p>Last updated: ${new Date().toLocaleDateString()}</p>
        </body>
        </html>
    `;

  res.send(termsContent);
});
