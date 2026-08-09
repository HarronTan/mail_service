import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function detectCategoryUsingAI(description, categories) {
  const result = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    contents: `
  You are an expense extraction and categorization assistant.
  Given a raw text describing a transaction, extract the amount, description and payment mode ('cash' | 'credit_card' | 'bank_transfer').
  If paymentMode is credit_card, also extract the last 4 digits of the card number.
  The category should be inferred off the description.

  Return ONLY the JSON in the exact format below — no explanations, no extra text:

  {
    "amount": "<number>",
    "description": "<string>",
    "paymentMode": "<string>",
    "card_number_last4": "<string> (if paymentMode is credit_card, else default to null)",
    "category": "<string>"
  }

  Use the following categories for classification:
  "${categories}"

  Text: "${description}"

  Fallback rules:
  If the input text provided is not a transaction that is made
  OR if the output amount or description is undefined,
  return a plain string stating the reason.
  `,
  });

  const text = (result.text ?? "").trim();
  console.log("AI output");
  console.log(text);

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) json = JSON.parse(match[0]);
    else throw new Error("No JSON found in response");
  }

  return json;
}
