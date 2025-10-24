import { adsense_v1_4 } from "googleapis";

const cleanText = `	
Dear Valued Customer

The following NETS QR payment has been made:

Date	: 24 Oct 2025
Time	: 12:35pm SGT
Amount	: SGD 5.10
From your account	: 360 Account (-462001)
To	: SAN HUP AMK 529
NETS merchant ID	: 11101027924
NETS Stan ID	: 000000
Reference number	: 2510240116548169

If you have any questions, please call our Personal Banking hotline: OCBC website > Contact us.

Thank you for banking with us. We look forward to serving you again.

Yours sincerely

Digital Business
Global Consumer Financial Services
OCBC
Tip: To subscribe or change your settings for e-Alerts, log in to OCBC Internet Banking > Customer Service (on the top navigation bar) > Manage e-Alerts.

Do allow us to warn you against phishing attempts involving e-mails that claim to be from OCBC. We will not send you any emails with links requesting your Access Code, PIN or One-time Password. Enter your login credentials only into the OCBC app or after accessing the OCBC website (always type out the URL to do this).


`
const regex = /made to\s+(.+?)\s+using.*?Amount\s*:\s*SGD\s*([\d,]+\.\d{2})/s;
const match = cleanText.match(regex);

if(match) {
const bodyPayload = {
    
    rawText: cleanText.slice(0, 200), // preview first 200 chars
    amount: match[2] ? match[2].trim() : "Unknown",
    description: match[1] ? match[1].trim() : 0,
}

console.log(1,bodyPayload)
process.exit(0)
}


const regexOCBC = /SGD\s*([\d,]+\.\d{2}).*at\s+(?:.*\s)?at\s+([^\.\n]+)\./i
const matchOCBC = cleanText.match(regexOCBC)
if (matchOCBC) {
const amount = matchOCBC[1].trim();
const merchant = matchOCBC[2].trim();
const bodyPayload = {
    
    rawText: cleanText.slice(0, 200), // preview first 200 chars
    amount: amount,
    description: merchant,
}
console.log(2,bodyPayload)
process.exit(0)
}


// Pattern 2: SB CC 
const regex2 = /\+?SGD\s*([\d,]+\.\d{2}).*at\s+([^\.]+)\./i;
const match2 = cleanText.match(regex2);
if (match2) {
const amount = match2[1].trim();
const merchant = match2[2].trim();
const bodyPayload = {
    
    rawText: cleanText.slice(0, 200), // preview first 200 chars
    amount: amount,
    description: merchant,
}
console.log(3,bodyPayload)
process.exit(0)
} 

// Pattern 3: DBS Paynow/CC && OCBC NETS QR
const regex3 = /Amount\s*:?\s*SGD\s*([\d,]+\.\d{2})[\s\S]*?To\s*:?\s*([^\n]+?)(?=\n|if unauthorised)/i;
const match3 = cleanText.match(regex3);

if (match3) {
const bodyPayload = {
    rawText: cleanText.slice(0, 200),
    amount: match3[1].trim(),
    description: match3[2].trim(),
};
console.log(4,bodyPayload)
process.exit(0)
}
