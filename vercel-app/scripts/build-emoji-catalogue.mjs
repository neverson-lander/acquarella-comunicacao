import {writeFile} from 'node:fs/promises';

// Version pinned so the client and server always validate the same catalogue.
const version='18.0.0',base=`https://cdn.jsdelivr.net/npm/emojibase-data@${version}/`;
async function download(file){const response=await fetch(base+file);if(!response.ok)throw Error(`Emoji dataset ${file}: ${response.status}`);return response.text();}
const [data,messages,license]=await Promise.all(['pt/data.json','pt/messages.json','LICENSE'].map(download));
const seen=new Set(),entries=[];
for(const parent of JSON.parse(data).filter(e=>Number.isInteger(e.group)).sort((a,b)=>a.order-b.order)){
 for(const entry of [parent,...(parent.skins||[])]){
  if(seen.has(entry.emoji))continue;seen.add(entry.emoji);
  entries.push([entry.emoji,entry.label,entry.group??parent.group,(parent.tags||[]).join(' ')]);
 }
}
const source=`// Generated from emojibase-data ${version}, Portuguese CLDR annotations. See emoji-catalogue.LICENSE.txt.\nexport const emojiGroups=${JSON.stringify(JSON.parse(messages).groups.map(g=>[g.order,g.message]))};\nexport const emojiCatalogue=${JSON.stringify(entries)};\n`;
await writeFile(new URL('../public/emoji-catalogue.mjs',import.meta.url),source);
await writeFile(new URL('../public/emoji-catalogue.LICENSE.txt',import.meta.url),`Source: https://github.com/milesj/emojibase (emojibase-data ${version})\n\n${license}`);
console.log(`${entries.length} emojis generated.`);
