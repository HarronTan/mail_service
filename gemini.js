import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

export async function detectCategoryUsingAI(description, categories) {
const result = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: `
  You are an expense extraction and categorization assistant.
  Given a raw text describing a transaction, extract the amount, description. 
  The category should be inferred off the description.

  Return ONLY the JSON in the exact format below — no explanations, no extra text:

  {
    "amount": "<number>",
    "description": "<string>",
    "category": "<string>"
  }


  Use the following categories for classification:
  "${categories}"

  Text: "${description}"
  `,
});

let text = result.text.trim();
console.log(text)
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