const text = `	
Dear Valued Customer,
 
Transaction Alert Primary / Supplementary Card Alert
Thank you for charging +SGD 33.93 on 27-Sep-25 08:17 PM to your credit card ****4633 at XIN YUE LAI B.`
const regex2 = /SGD\s*([\d,]+\.\d{2}).*at\s+(?:.*\s)?at\s+([^\.\n]+)\./i



const match2 = text.match(regex2);
// const amount = match2[1].trim();
// const merchant = match2[2].trim();
// console.log(amount)
// console.log(merchant)

console.log(match2[1])
console.log(match2[2])