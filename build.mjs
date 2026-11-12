import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root=path.dirname(fileURLToPath(import.meta.url));
const output=path.resolve(process.argv[2]||path.join(root,'../../outputs'));
mkdirSync(output,{recursive:true});
let html=readFileSync(path.join(root,'index.template.html'),'utf8');
for(const [marker,file] of [['STYLE','style.css'],['ENGINE','engine.js'],['APP','app.js']])html=html.replace(`/* ${marker} */`,()=>readFileSync(path.join(root,file),'utf8'));
const serverAddress=process.argv[3]||process.env.DOTLANDS_SERVER||'';
if(serverAddress){
  const address=new URL(serverAddress);
  if(!['https:','http:'].includes(address.protocol)||address.username||address.password||address.search||address.hash)throw new Error('Use a plain HTTP or HTTPS multiplayer server address.');
  html=html.replace("const DEFAULT_SERVER = '';",()=>`const DEFAULT_SERVER = ${JSON.stringify(address.href.replace(/\/+$/,''))};`);
}
for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
if(/<script[^>]+src=|https?:\/\/fonts|url\(['"]?https?:/i.test(html))throw new Error('Unexpected remote dependency.');
writeFileSync(path.join(output,'index.html'),html);
console.log(`Built standalone index.html (${Math.round(Buffer.byteLength(html)/1024)} KB); both embedded scripts parse.`);
