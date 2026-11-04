// Leitura do print da corretora (Meus ativos > Importar carteira): o app grava cada imagem em leituras/{id}
// { uid, lote, tipo, partes, status: 'novo' }, com a imagem em base64 dividida em leituras/{id}/partes/{0,1,...}
// (o Firestore aceita até 1 MB por documento e o print de tela vem em PNG grande). A cada rodada o robô lê as novas
// com o Claude Haiku, devolve em res (JSON: [{ tk, q, p, duvida }]) com status 'pronto' (ou 'erro' e o motivo em
// msg) e apaga as partes da imagem.
// O app escuta o documento e mostra a conferência; nada é salvo na carteira sem a pessoa conferir.
// Travas de custo: até 10 prints por pessoa por dia e 30 por rodada. Leituras com mais de 2 dias são apagadas.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PROJETO = 'infobolsa-investimentos';
const TOKEN = process.env.GOOGLE_TOKEN;
if (!TOKEN) { console.log('sem GOOGLE_TOKEN: pulei os prints'); process.exit(0); }
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const POR_DIA = 10, POR_RODADA = 30;
const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

const valor = (v) => (v?.stringValue ?? v?.integerValue ?? v?.timestampValue ?? v?.booleanValue ?? null);
async function consulta(filtro) {
  const r = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'leituras' }], where: filtro, limit: 300 } }) });
  if (!r.ok) throw new Error(`Firestore ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).filter((x) => x.document).map((x) => x.document);
}
const igual = (campo, v) => ({ fieldFilter: { field: { fieldPath: campo }, op: 'EQUAL', value: { stringValue: v } } });
async function gravar(nome, campos) {
  const mask = Object.keys(campos).map((k) => `updateMask.fieldPaths=${k}`).join('&');
  const fields = Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, { stringValue: String(v) }]));
  const r = await fetch(`https://firestore.googleapis.com/v1/${nome}?${mask}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) console.log(`não gravei ${nome.split('/').pop()}: ${r.status}`);
}

// tickers conhecidos (os mesmos que o app tem); o que a IA ler fora disso vai como dúvida
const conhecidos = new Set();
for (const arq of ['site/cotacoes.json']) {
  if (existsSync(arq)) for (const tk of Object.keys(JSON.parse(readFileSync(arq, 'utf8')).q || {})) conhecidos.add(tk);
}

const ESQUEMA = {
  type: 'object',
  properties: {
    e_carteira: { type: 'boolean' },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tk: { type: 'string' }, q: { type: 'number' }, p: { anyOf: [{ type: 'number' }, { type: 'null' }] }, duvida: { type: 'boolean' } },
        required: ['tk', 'q', 'p', 'duvida'],
        additionalProperties: false,
      },
    },
  },
  required: ['e_carteira', 'itens'],
  additionalProperties: false,
};
const SISTEMA = 'Você lê prints da carteira de investimentos de corretoras brasileiras (posição em ações, FIIs, Fiagros, ETFs e BDRs). '
  + 'Para cada ativo da bolsa que aparecer, devolva o ticker (ex.: PETR4, MXRF11, IVVB11, AAPL34, sem o F do fracionário), a quantidade total e o preço médio por ação ou cota em reais. '
  + 'Se o print não mostrar o preço médio, p é null; não calcule a partir do valor total nem use a cotação atual. '
  + 'Se o mesmo ticker aparecer no fracionário e no lote padrão, some as quantidades e use como preço médio a média ponderada pelas quantidades. Ignore renda fixa, Tesouro, fundos de investimento, cripto e saldo em conta. '
  + 'Marque duvida true quando algum número estiver cortado, borrado ou ambíguo. Se a imagem não for uma carteira de investimentos, e_carteira é false e a lista vem vazia.';

// junta as partes da imagem e já apaga (a imagem não fica guardada)
async function imagem(nome) {
  const r = await fetch(`https://firestore.googleapis.com/v1/${nome}/partes?pageSize=20`, { headers: H });
  if (!r.ok) throw new Error(`partes ${r.status}`);
  const docs = ((await r.json()).documents || []).sort((a, b) => Number(a.name.split('/').pop()) - Number(b.name.split('/').pop()));
  const img = docs.map((x) => valor(x.fields?.d) || '').join('');
  for (const x of docs) await fetch(`https://firestore.googleapis.com/v1/${x.name}`, { method: 'DELETE', headers: H });
  return img;
}

let anthropic = null;
async function ler(img, tipo) {
  if (!anthropic) {
    if (!existsSync('node_modules/@anthropic-ai/sdk')) execSync('npm install --no-save --no-audit --no-fund @anthropic-ai/sdk@1.4.0', { stdio: 'ignore' });
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  }
  const r = await anthropic.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 3000,
    system: SISTEMA,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: tipo, data: img } }, { type: 'text', text: 'Leia as posições deste print.' }] }],
  });
  if (r.stop_reason !== 'end_turn') throw new Error(`a IA parou (${r.stop_reason})`);
  return JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{}');
}

// PRINTS=1 (input "prints" do workflow): lê o print de exemplo do repositório e mostra no log, sem mexer em nada
if (process.env.PRINTS === '1') {
  console.log('teste:', JSON.stringify(await ler(readFileSync('exemplos/print-corretora.png').toString('base64'), 'image/png')));
}

const novas = await consulta(igual('status', 'novo'));
// limpeza: o que tem mais de 2 dias sai (a pessoa já conferiu ou desistiu)
const limite = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
let apagadas = 0;
for (const st of ['pronto', 'erro']) {
  for (const d of await consulta(igual('status', st))) {
    if ((valor(d.fields.criadoEm) || '') < limite && (await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: H })).ok) apagadas++;
  }
}
if (!novas.length) { console.log(`prints: nenhum novo${apagadas ? `, ${apagadas} antigo(s) apagado(s)` : ''}`); process.exit(0); }

// quantos cada pessoa já leu hoje (para a trava diária)
const hojePor = new Map();
for (const st of ['pronto', 'erro']) for (const d of await consulta(igual('status', st))) {
  if (valor(d.fields.dia) === hoje && valor(d.fields.msg) !== 'limite') { const u = valor(d.fields.uid); hojePor.set(u, (hojePor.get(u) || 0) + 1); }
}

let lidas = 0, falhas = 0;
const avisar = new Set();
for (const d of novas.slice(0, POR_RODADA)) {
  const f = d.fields;
  const uid = valor(f.uid);
  avisar.add(uid);
  const n = hojePor.get(uid) || 0;
  if (n >= POR_DIA) { await imagem(d.name).catch(() => {}); await gravar(d.name, { status: 'erro', msg: 'limite', dia: hoje }); continue; }
  hojePor.set(uid, n + 1);
  try {
    const img = await imagem(d.name);
    if (img.length < 100) throw new Error('imagem vazia');
    const tipo = /^image\/(png|jpeg|webp|gif)$/.test(valor(f.tipo) || '') ? valor(f.tipo) : 'image/jpeg';
    const j = await ler(img, tipo);
    if (!j.e_carteira) { await gravar(d.name, { status: 'erro', msg: 'nao-e-carteira', dia: hoje }); continue; }
    const itens = (j.itens || [])
      .map((x) => ({ tk: String(x.tk || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]{4}\d{1,2})F$/, '$1'), q: Math.round(Number(x.q) || 0), p: Number(x.p) > 0 ? Math.round(Number(x.p) * 100) / 100 : null, duvida: !!x.duvida }))
      .filter((x) => /^[A-Z]{4}\d{1,2}$/.test(x.tk) && x.q > 0)
      .map((x) => (conhecidos.size && !conhecidos.has(x.tk) ? { ...x, duvida: true } : x));
    await gravar(d.name, { status: 'pronto', res: JSON.stringify(itens), dia: hoje });
    lidas++;
  } catch (e) {
    console.log(`print não lido: ${e.message}`);
    await gravar(d.name, { status: 'erro', msg: 'falha', dia: hoje });
    falhas++;
  }
}
// avisa no celular de quem mandou (a leitura pode levar uns minutos e a pessoa já saiu do app)
for (const uid of avisar) {
  if (novas.slice(POR_RODADA).some((d) => valor(d.fields.uid) === uid)) continue; // ainda tem print dele na fila
  try {
    const u = await (await fetch(`${BASE}/usuarios/${uid}`, { headers: H })).json();
    const token = u.fields?.push?.mapValue?.fields?.token?.stringValue;
    if (!token) continue;
    await fetch(`https://fcm.googleapis.com/v1/projects/${PROJETO}/messages:send`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: { token, notification: { title: 'Seu print foi lido', body: 'Confira em Meus ativos antes de salvar na carteira.' }, data: { tela: 'ativos' }, android: { priority: 'high', notification: { channel_id: 'avisos', color: '#FFB400' } } } }),
    });
  } catch (e) { console.log(`aviso do print: ${e.message}`); }
}
console.log(`ok: ${lidas} print(s) lido(s)${falhas ? `, ${falhas} com falha` : ''}${apagadas ? `, ${apagadas} antigo(s) apagado(s)` : ''}`);
if (falhas && !lidas) process.exit(1);
