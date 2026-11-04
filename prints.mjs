// A leitura de print saiu do app em 04/11/2026 (agora a importação é pela nota de corretagem, no leitor do
// Cloudflare). Isto só apaga o que sobrou em leituras/{id} e nas partes das imagens. Roda uma vez e sai do robô.
const PROJETO = 'infobolsa-investimentos';
const TOKEN = process.env.GOOGLE_TOKEN;
if (!TOKEN) { console.log('sem GOOGLE_TOKEN: pulei a limpeza dos prints'); process.exit(0); }
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const r = await fetch(`${BASE}/leituras?pageSize=300`, { headers: H });
if (!r.ok) throw new Error(`Firestore ${r.status}`);
const docs = (await r.json()).documents || [];
let apagados = 0;
for (const d of docs) {
  const p = await fetch(`https://firestore.googleapis.com/v1/${d.name}/partes?pageSize=20`, { headers: H });
  for (const x of (p.ok ? (await p.json()).documents : []) || []) if ((await fetch(`https://firestore.googleapis.com/v1/${x.name}`, { method: 'DELETE', headers: H })).ok) apagados++;
  if ((await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: H })).ok) apagados++;
}
// partes soltas (documento principal que nunca chegou a ser gravado)
const soltas = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'partes', allDescendants: true }], limit: 300 } }) });
for (const x of soltas.ok ? await soltas.json() : []) {
  if (x.document?.name.includes('/leituras/') && (await fetch(`https://firestore.googleapis.com/v1/${x.document.name}`, { method: 'DELETE', headers: H })).ok) apagados++;
}
console.log(`limpeza dos prints: ${docs.length} leitura(s), ${apagados} documento(s) apagado(s)`);
