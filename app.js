import express from "express";
import { google } from "googleapis";
import bodyParser from "body-parser";
import "dotenv/config";
import { PubSub } from "@google-cloud/pubsub";
 
import { readFileSync } from "fs";

const serviceAccount = JSON.parse(readFileSync(new URL("./service-account.json", import.meta.url)));

const app = express();
app.use(bodyParser.json());

const port = process.env.PORT
const host = process.env.HOST

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  `https://${host}/oauth2callback`
);

function createOAuthClient(user,tokens) {
  const client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    `https://${host}/oauth2callback`
  );
  client.setCredentials(tokens);
    // Auto-refresh listener
  client.on("tokens", async (newTokens) => {
    if (newTokens.refresh_token) {
      tokens.refresh_token = newTokens.refresh_token;
    }
    if (newTokens.access_token) {
      tokens.access_token = newTokens.access_token;
      tokens.expiry_date = newTokens.expiry_date;
    }
    userState.set(user,tokens)
  });
  return client;
}

const userState = new Map()
const userLastHistoryId = new Map()
// Step 1: Generate Auth URL
app.get("/auth", (req, res) => {
  const { userId } = req.query;
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", 
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    state: userId
  });
  res.redirect(url);
});

// Step 2: Handle OAuth2 callback
app.get("/oauth2callback", async (req, res) => {
  const { code,state } = req.query;
  const { tokens } = await oAuth2Client.getToken(code);

  // Store tokens securely (DB, encrypted store)
  console.log("Tokens acquired:", tokens);

  userState.set(state,tokens)
  res.send(`User ${state} authenticated successfully!`);
});

// Step 3: Fetch emails and extract transactions
app.get("/transactions", async (req, res) => {
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // Query emails that may contain transactions
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: "Paynow transfer made", // adjust as needed
    maxResults: 10,
  });

  if (!data.messages) return res.json([]);

  const transactions = [];

  for (const msg of data.messages) {
    const { data: fullMsg } = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
    });

    const rawBody = getBody(fullMsg.payload);
    const cleanText = /<[^>]+>/.test(rawBody) ? htmlToText(rawBody) : rawBody;

    // Example regex (adjust as needed)
    const regex = /made to\s+(.+?)\s+using.*?Amount\s*:\s*SGD\s*([\d,]+\.\d{2})/s;
    const match = cleanText.match(regex);

    transactions.push({
      snippet: fullMsg.snippet,
      rawText: cleanText.slice(0, 200), // preview first 200 chars
      amount: match[2] ? match[2].trim() : "Unknown",
      description: match[1] ? match[1].trim() : 0,
    });
  }

  // await sendToDb(transactions[0])


  res.json(transactions);
});

app.get("/start-watch/:userId", async (req, res) => {
  const tokens = userState.get(req.params.userId)
  const auth = createOAuthClient(tokens,tokens)
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

// app.post("/pubsub", async (req, res) => {
//   const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
//   const message = Buffer.from(req.body.message.data, "base64").toString("utf-8");
//   const data = JSON.parse(message);
//   console.log("📩 Gmail update:", data);

//   const history = await gmail.users.history.list({
//     userId: "me",
//     startHistoryId: data.historyId,
//   });

//   console.log(history)

//   // data has historyId (points to new changes)
//   res.status(200).send();
// });

app.get("/startSub", async (req,res) => {
  const pubsub = new PubSub({ projectId: "mail-service-470611", credentials: serviceAccount });
  const subscription = pubsub.subscription("gmail-updates-sub");

  subscription.on("message", async (msg) => {
  
  try {
    const data = JSON.parse(msg.data.toString());
    console.log("📩 Gmail update:", data);

    const userEmail = data.emailAddress
    const userID = userEmail === "harrontan@gmail.com" ? 
    "56ab3477-86d3-4814-9ccc-7221ad1398ab":
    "2e20e8b7-967f-423b-9f08-24b620b0b4f7"    
    
    const user = userEmail === "harrontan@gmail.com" ? "harron" : "jw"
    const tokens = userState.get(user)
    if(!tokens) return

    const auth = createOAuthClient(user,tokens)
    const gmail = google.gmail({ version: "v1", auth });
    const lastHistoryId = userLastHistoryId.get(user)

    if (!lastHistoryId) {
      userLastHistoryId.set(user,data.historyId);
      console.log("📌 Initialized history checkpoint:", data.historyId);
      msg.ack();
      return;
    }

    const historyRes = await gmail.users.history.list({
      userId: userEmail,
      startHistoryId: lastHistoryId,
    });

    const history = historyRes.data.history || [];
    for (const record of history) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          const messageId = added.message.id;
          const message = await gmail.users.messages.get({
            userId: userEmail,
            id: messageId,
          });

          const snippet = message.data.snippet;
          const internalDate = parseInt(message.data.internalDate);

          // Only process if received AFTER we started
          if (internalDate > Date.now() - 60 * 1000) {
            
            const rawBody = getBody(message.data.payload);
            const cleanText = /<[^>]+>/.test(rawBody) ? htmlToText(rawBody) : rawBody;

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
          }
        }
      }
    }

    userLastHistoryId.set(user,data.historyId)

    msg.ack();
    } catch (err) {
    console.error("❌ Error handling message:", err);
  }
  });

  subscription.on("error", (err) => {
    console.error("❌ Subscription error:", err);
  });

  res.status(200).send();
})

app.listen(port, () => {
  console.log(`Server running on https://${host}:${port}`);
});

async function sendToDb(transaction,user_id) {
  
  const amount = Number(transaction.amount)
  const description = transaction.description
  const category_name = "Others"


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


import * as cheerio from "cheerio";

function htmlToText(html) {
  const $ = cheerio.load(html);
  return $("body").text().replace(/\s+/g, " ").trim(); // collapse whitespace
}
