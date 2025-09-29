"use strict";
import express from "express";
import { google } from "googleapis";
import bodyParser from "body-parser";
import "dotenv/config";
import { PubSub } from "@google-cloud/pubsub";
import { readFileSync } from "fs";
import webPush from "web-push";
import { createClient } from '@supabase/supabase-js'
import * as cheerio from "cheerio";

webPush.setVapidDetails(
  "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const supabaseUrl = 'https://doqgomabmxpcijxoliff.supabase.co'
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

const serviceAccount = JSON.parse(readFileSync(new URL("./service-account.json", import.meta.url)));

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT
const host = process.env.HOST
const PROTOCOL = process.env.PROTOCOL

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  `${PROTOCOL}://${host}/oauth2callback`
);


async function getEmailFromAccessToken(access_token) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!resp.ok) throw new Error('Failed to fetch userinfo: ' + resp.status);
  const profile = await resp.json();
  // profile.email, profile.email_verified, profile.sub, profile.name, profile.picture
  return profile;
}

const clients = new Map();

export function getOAuthClient(userID, tokens) {
  if (clients.has(userID)) {
    return clients.get(userID);
  }

  const client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    `${PROTOCOL}://${host}/oauth2callback`
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
    scope: ["https://www.googleapis.com/auth/gmail.readonly",    
      "email",
      "profile"],
  });
  res.redirect(url);
});

// Step 2: Handle OAuth2 callback
app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oAuth2Client.getToken(code);
  const {access_token} = tokens
  const profile = await getEmailFromAccessToken(access_token)
  const email = profile.email

  //check user in db
  const user  = await getUser(email)
  if(user == null) {
    res.send(`User is not registered.`)
    return
  }

  await updateOauthToken(user.id,tokens)

  const auth = await getOAuthClient(user.id,tokens)
  const gmail = google.gmail({ version: "v1", auth });

  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: "projects/mail-service-470611/topics/gmail-updates",
      labelIds: ["INBOX"], 
    },
  });
  const data =response.data

  await updateLastHistoryId(user.id,data.historyId ?? "")

  // userState.set(state,tokens)
  res.send(`User ${email} authenticated successfully!`);
});

app.get("/start-watch", async (req, res) => {
  const user = await getUser("harrontan@gmail.com")
  const tokens = await getUserToken(user.id)
  const auth = await createOAuthClient(user.id,tokens)
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

app.get("/startSub", async (req,res) => {
  startServer()

  res.status(200).send();
})

app.listen(port, () => {
  console.log(`Server running on ${PROTOCOL}://${host}:${port}`);
  startServer()
});

app.get("/test/send", async (req,res) => {
  await sendUserNotification("56ab3477-86d3-4814-9ccc-7221ad1398ab", 1.5, "test notification")

  res.status(200).send()
})

function detectCategory(description) {
  if (!description) return "Others";

  const categoryMap = {
    "PARKING.SG": "Transport",
    "GRAB": "Transport",
    "COMFORT": "Transport",
    "MRT": "Transport",
    "BUS": "Transport",
  };

  const upperDesc = description.toUpperCase();

  for (const [keyword, category] of Object.entries(categoryMap)) {
    if (upperDesc.includes(keyword)) {
      return category;
    }
  }

  return "Food"; // fallback
}


async function sendToDb(transaction,user_id) {
  
  const amount = Number(transaction.amount)
  const description = transaction.description
  const category_name = detectCategory(description)


  const response = await fetch('https://doqgomabmxpcijxoliff.supabase.co/functions/v1/add-expense', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      {
        "user_id": user_id,
        "amount": amount,
        "description": description,
        "category_name": category_name
      }
    ),
  })

  const data = await response.json()
  console.log(data)
  console.log(`Successfully added data to db!`)

  await sendUserNotification(user_id,amount,description)

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

async function sendUserNotification(userId,amount,desc) {
  
  let { data, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId)
  
  if(data.length != 1) return

  data = data[0]
  const subscription = {
    endpoint: data.endpoint,
    keys: {
      p256dh: data.p256dh,
      auth: data.auth
    }
  }

  const payload = JSON.stringify({
    title: "New Transaction",
    body: `You spent ${amount} at ${desc}`,
    icon: "/icons/notification.png",
    // url: "https://your-app.com/expenses"
  });

  await sendNotification(subscription,payload)

}

async function sendNotification(subscription,payload) {
  try {
    await webPush.sendNotification(subscription, payload);
    console.log("✅ Push notification sent!");
  } catch (err) {
    console.error("❌ Error sending push:", err);
  }
}


async function getUser(email) {
  if(email === "jingwenmvp@gmail.com") {
    email = "jing_wen@live.com"
  }
  const { data, error } = await supabase.auth.admin.listUsers({
    limit: 1000, // optional: max 1000 at a time
  });
  
  if (error) {
    console.error(error)
    return null
  }

  const user = data.users.find(u => u.email === email);

  if (!user) {
    console.log("no user found.")
    null
  } else {
    return {
      id: user.id,
      email: user.email
    }
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

async function updateOauthToken(user_id,tokens) {
  await supabase
  .from("oauth_tokens")
  .upsert({
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
    .single()

  if (error) {
    if (error.code === "PGRST116") return null; // no row found
    throw error;
  }

  return data.history_id;

}
async function updateLastHistoryId(user_id,history_id) {
  await supabase
  .from("last_history_id")
  .upsert({
    user_id, 
    history_id,
    updated_at: new Date().toISOString(),
  }); 
}

async function startServer() {
  console.log("Starting server....")
  const pubsub = new PubSub({ projectId: "mail-service-470611", credentials: serviceAccount });
  const subscription = pubsub.subscription("gmail-updates-sub");

  subscription.on("message", async (msg) => {
  
    try {
      const data = JSON.parse(msg.data.toString());
      console.log("📩 Gmail update:", data);

      const user  = await getUser(data.emailAddress)
      if(user == null) return
      const userID = user.id
      const tokens = await getUserToken(userID)
      if(tokens == null) return
      const auth = await getOAuthClient(userID,tokens)
      
      const gmail = google.gmail({ version: "v1", auth });
      const lastHistoryId = await getLastHistoryId(userID)
      if(lastHistoryId == null) return

      const historyRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: lastHistoryId,
      });
      await updateLastHistoryId(userID,data.historyId)

      const history = historyRes.data.history || [];
      
      for (const record of history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            const messageId = added.message.id;

            let message;
            try {
              message = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
              });
            } catch (err) {
              console.error(`Error fetching message ${messageId}`);
              continue; // skip this message and continue with next
            }

              const snippet = message.data.snippet;
              const internalDate = parseInt(message.data.internalDate);

              // Only process if received AFTER we started
              if (internalDate > Date.now() - 60 * 1000) {
              
              const rawBody = getBody(message.data.payload);
              const cleanText = /<[^>]+>/.test(rawBody) ? htmlToText(rawBody) : rawBody;

              // Pattern 1: OCBC Paynow
              const regex = /made to\s+(.+?)\s+using.*?Amount\s*:\s*SGD\s*([\d,]+\.\d{2})/s;
              const match = cleanText.match(regex);

              if(match) {
                const bodyPayload = {
                  snippet: snippet,
                  rawText: cleanText.slice(0, 200), // preview first 200 chars
                  amount: match[2] ? match[2].trim() : "Unknown",
                  description: match[1] ? match[1].trim() : 0,
                }
                await sendToDb(bodyPayload,userID)
              }

              // Pattern 2: SB CC
              const regex2 = /\+SGD\s*([\d,]+\.\d{2}).*?at\s+(.+?)\s*(?:-|)\s*\./s;
              const match2 = cleanText.match(regex2);
              if (match2) {
                const amount = match2[1].trim();
                const merchant = match2[2].trim();
                const bodyPayload = {
                  snippet: snippet,
                  rawText: cleanText.slice(0, 200), // preview first 200 chars
                  amount: amount,
                  description: merchant,
                }
                await sendToDb(bodyPayload,userID)
              } 

              // Pattern 3: DBS Paynow/CC && OCBC NETS QR
              const regex3 = /Amount\s*:?\s*SGD\s*([\d,]+\.\d{2})[\s\S]*?To\s*:?\s*([^\n]+?)(?=\n|if unauthorised)/i;
              const match3 = cleanText.match(regex3);

              if (match3) {
                const bodyPayload = {
                  snippet,
                  rawText: cleanText.slice(0, 200),
                  amount: match3[1].trim(),
                  description: match3[2].trim(),
                };
                await sendToDb(bodyPayload, userID);
              }

            }
          }
        }
      }

      msg.ack();
      } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  subscription.on("error", (err) => {
    console.error("❌ Subscription error:", err);
  });
} 
