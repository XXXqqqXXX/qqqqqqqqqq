import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { extname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.STEPWISE_DATA_DIR || join(root, 'data'));
const dataFile = join(dataDir, 'store.json');
const seedFile = join(root, 'data', 'seed.json');
const uploadsDir = join(dataDir, 'uploads');
const port = Number(process.env.PORT || 4173);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.png':'image/png', '.webp':'image/webp' };

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') console.warn(`Не удалось загрузить .env: ${error.message}`); }
}

async function loadStore() {
  await mkdir(dataDir, { recursive:true });
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      const backup=`${dataFile}.corrupt-${Date.now()}.bak`;
      try { await rename(dataFile,backup); console.warn(`Некорректный файл данных сохранён как ${backup}`); } catch {}
    }
    const seed = JSON.parse(await readFile(seedFile, 'utf8'));
    await writeFile(dataFile, JSON.stringify(seed, null, 2), 'utf8');
    return seed;
  }
}

let store = await loadStore();
let writeQueue = Promise.resolve();
const persist = () => { writeQueue = writeQueue.then(() => writeFile(dataFile, JSON.stringify(store, null, 2), 'utf8')); return writeQueue; };
const send = (res, status, body) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'x-content-type-options':'nosniff' }); res.end(JSON.stringify(body)); };
const readBody = (req, limit=8_000_000) => new Promise((resolveBody, reject) => {
  const chunks=[]; let size=0; let done=false;
  req.on('data', chunk => { size += chunk.length; if (size > limit) { done=true; reject(new Error('Слишком большой запрос.')); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => { if(done)return; try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Некорректный JSON.')); } });
  req.on('error', reject);
});
const safeFile = (base, name) => { const target=resolve(base, name); const rel=relative(base,target); return rel.startsWith('..') || rel.includes(':') ? null : target; };
const isCoverImage = value => typeof value==='string' && (/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(value) || /^https:\/\/images\.unsplash\.com\/photo-[a-zA-Z0-9-]+\?(?:[a-zA-Z0-9%._=-]+&?)*$/.test(value));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods':'GET,POST,PUT,OPTIONS', 'access-control-allow-headers':'content-type' }); return res.end(); }

    if (url.pathname.startsWith('/uploads/')) {
      const filename=url.pathname.slice('/uploads/'.length);
      if (!/^[a-f0-9-]+\.(?:jpg|png|webp)$/.test(filename)) { res.writeHead(404); return res.end('Not found'); }
      const image=await readFile(join(uploadsDir,filename));
      res.writeHead(200,{ 'content-type':mime[extname(filename)], 'cache-control':'public, max-age=31536000, immutable', 'x-content-type-options':'nosniff' });
      return res.end(image);
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health' && req.method === 'GET') return send(res,200,{ ok:true, app:'STEPWISE' });
      if (url.pathname === '/api/guides' && req.method === 'GET') return send(res,200,{ guides:store.guides });
      if (url.pathname === '/api/events' && req.method === 'GET') return send(res,200,{ events:store.events });
      if (url.pathname === '/api/profile' && req.method === 'GET') return send(res,200,{ author:store.author });

      if (url.pathname === '/api/profile' && req.method === 'PUT') {
        const author=await readBody(req,50_000);
        if (typeof author.name !== 'string' || !author.name.trim() || author.name.length>50) return send(res,400,{ error:'Укажите имя автора (до 50 символов).' });
        const previousName=store.author.name, nextName=author.name.trim();
        if(previousName!==nextName) store.guides=store.guides.map(guide=>guide.author===previousName?{...guide,author:nextName}:guide);
        store.author={ name:nextName, email:typeof author.email==='string'?author.email.trim().slice(0,100):'' };
        await persist(); return send(res,200,{ author:store.author });
      }

      if (url.pathname === '/api/events' && req.method === 'POST') {
        const event=await readBody(req,50_000);
        if (typeof event.type!=='string' || typeof event.guideId!=='string' || !store.guides.some(guide=>guide.id===event.guideId)) return send(res,400,{ error:'Событие должно ссылаться на существующую инструкцию.' });
        const saved={ type:event.type.slice(0,40), guideId:event.guideId, sessionId:typeof event.sessionId==='string'?event.sessionId.slice(0,80):'', step:Number.isInteger(event.step)?event.step:null, id:randomUUID(), at:new Date().toISOString() };
        store.events.push(saved); await persist(); return send(res,201,{ event:saved });
      }

      if (url.pathname === '/api/guides' && req.method === 'POST') {
        const guide=await readBody(req,500_000);
        if (typeof guide.title!=='string' || !guide.title.trim() || !Array.isArray(guide.steps) || guide.steps.length<2 || guide.steps.length>40) return send(res,400,{ error:'Добавьте название и от 2 до 40 шагов.' });
        if (guide.steps.some(step=>typeof step.title!=='string' || !step.title.trim() || typeof step.text!=='string' || !step.text.trim())) return send(res,400,{ error:'У каждого шага должно быть название и описание.' });
        const clean={ ...guide, id:typeof guide.id==='string'&&store.guides.some(item=>item.id===guide.id)?guide.id:randomUUID(), title:guide.title.trim().slice(0,90), description:String(guide.description||'').trim().slice(0,240), coverImage:isCoverImage(guide.coverImage)?guide.coverImage:'', author:store.author.name, published:true, steps:guide.steps.map(step=>({ title:step.title.trim().slice(0,90), text:step.text.trim().slice(0,900), tip:String(step.tip||'').trim().slice(0,240), image:/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(step.image||'')?step.image:'' })) };
        const index=store.guides.findIndex(item=>item.id===clean.id);
        if(index<0) store.guides.unshift(clean); else store.guides[index]=clean;
        await persist(); return send(res,201,{ guide:clean });
      }

      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        const upload=await readBody(req,7_500_000);
        const types={ 'image/jpeg':{ ext:'jpg', signature:bytes=>bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff }, 'image/png':{ ext:'png', signature:bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) }, 'image/webp':{ ext:'webp', signature:bytes=>bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP' } };
        const type=types[upload.type]; if(!type||typeof upload.data!=='string') return send(res,400,{ error:'Поддерживаются изображения JPG, PNG и WebP.' });
        const bytes=Buffer.from(upload.data,'base64');
        if(!bytes.length||bytes.length>5_000_000) return send(res,413,{ error:'Размер изображения не должен превышать 5 МБ.' });
        if(!type.signature(bytes)) return send(res,400,{ error:'Файл не похож на изображение заявленного формата.' });
        await mkdir(uploadsDir,{recursive:true}); const filename=`${randomUUID()}.${type.ext}`;
        await writeFile(join(uploadsDir,filename),bytes,{flag:'wx'});
        return send(res,201,{ url:`/uploads/${filename}` });
      }

      if (url.pathname === '/api/ai/draft' && req.method === 'POST') {
        if(!process.env.ANYMODEL_API_KEY) return send(res,503,{ error:'ИИ пока не настроен. Добавьте ANYMODEL_API_KEY в локальный файл .env и перезапустите сервер.' });
        const input=await readBody(req,30_000); const topic=typeof input.topic==='string'?input.topic.trim().slice(0,6000):'';
        if(!topic) return send(res,400,{ error:'Опишите тему или вставьте исходный материал.' });
        const response=await fetch(`${process.env.ANYMODEL_BASE_URL||'https://anymodel.org/v1'}/chat/completions`,{
          method:'POST',headers:{ 'authorization':`Bearer ${process.env.ANYMODEL_API_KEY}`, 'content-type':'application/json' },signal:AbortSignal.timeout(45_000),
          body:JSON.stringify({ model:process.env.ANYMODEL_MODEL||'cx/gpt-6-luna', temperature:0.3, max_tokens:2200, messages:[
            { role:'system', content:'Ты помощник-редактор пошаговых инструкций. Подготовь точный, осторожный черновик по теме пользователя. Не добавляй неподтверждённые опасные действия. Верни только JSON-объект без Markdown: {"title":"...","description":"...","category":"Компьютеры|Мониторы и периферия|Техника и гаджеты|Кухня и выпечка|Дом и быт|Учёба и навыки","difficulty":"Легко|Средне|Продвинуто","duration":30,"materials":["..."],"outcome":"...","steps":[{"title":"...","text":"...","tip":""}]}. Нужно 3–10 коротких последовательных шагов. При нехватке вводных укажи предположения в description или tips.' },
            { role:'user', content:topic }
          ] })
        });
        if(!response.ok){const detail=(await response.text()).slice(0,500);return send(res,502,{ error:`AnyModel вернул ошибку ${response.status}. ${detail}` });}
        const result=await response.json(); let content=result.choices?.[0]?.message?.content;
        if(Array.isArray(content)) content=content.map(part=>part.text||'').join('');
        try { const match=String(content||'').match(/\{[\s\S]*\}/); const draft=JSON.parse(match?.[0]||'');
          if(typeof draft.title!=='string'||!Array.isArray(draft.steps)) throw new Error('Формат черновика не распознан.');
          return send(res,200,{ draft:{ title:draft.title.slice(0,90), description:String(draft.description||'').slice(0,240), category:['Компьютеры','Мониторы и периферия','Техника и гаджеты','Кухня и выпечка','Дом и быт','Учёба и навыки'].includes(draft.category)?draft.category:'Техника и гаджеты', difficulty:['Легко','Средне','Продвинуто'].includes(draft.difficulty)?draft.difficulty:'Легко', duration:Math.min(999,Math.max(1,Number(draft.duration)||30)), materials:Array.isArray(draft.materials)?draft.materials.slice(0,15).map(String):[], outcome:String(draft.outcome||'').slice(0,500), steps:draft.steps.slice(0,40).map(step=>({ title:String(step.title||'').slice(0,90), text:String(step.text||'').slice(0,900), tip:String(step.tip||'').slice(0,240), image:'' })) } });
        } catch(error) { return send(res,502,{ error:`Не удалось разобрать ответ модели: ${error.message}` }); }
      }
      return send(res,404,{ error:'API-маршрут не найден.' });
    }

    const path=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
    const filename=safeFile(root,`.${path}`); if(!filename){res.writeHead(403);return res.end('Forbidden');}
    try { const bytes=await readFile(filename); res.writeHead(200,{ 'content-type':mime[extname(filename)]||'application/octet-stream', 'x-content-type-options':'nosniff' }); res.end(bytes); }
    catch { res.writeHead(404,{ 'content-type':'text/plain; charset=utf-8' }); res.end('Not found'); }
  } catch(error) {
    if(!res.headersSent) send(res,500,{ error:error.message||'Ошибка сервера.' }); else res.destroy();
  }
});

server.listen(port,()=>console.log(`STEPWISE открыт: http://localhost:${port}`));
