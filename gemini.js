import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

export async function detectCategoryUsingAI(description, categories) {
const result = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: `
    You are an expense categorization assistant.
    Given the merchant name, assign this transaction to the specified categories.
    Return ONLY the JSON in the format:
    {"category": "..."} — no explanations, no extra text.

    Merchant: "${description}"
    Categories: "${categories}"
  `,
});

let text = result.text.trim();

// Try to parse JSON directly
let json;
try {
  json = JSON.parse(text);
} catch (e) {
  // Fallback if the response includes text around the JSON
  const match = text.match(/\{[\s\S]*\}/);
  if (match) json = JSON.parse(match[0]);
  else throw new Error("No JSON found in response");
}

console.log(json.category); // e.g. "Food"
return json.category
}
