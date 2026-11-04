// Leitor de prints da corretora (Cloudflare Worker, plano grátis): o app manda o print e recebe na hora o que a
// IA leu, sem esperar a rodada do robô. Fluxo: confere o login do Firebase (token do usuário), conta o limite do
// dia (30 prints por pessoa, no KV LIMITE), manda a imagem para o Claude Haiku e devolve { e_carteira, itens }.
// A chave da Anthropic fica só aqui, como segredo do Worker (ANTHROPIC_API_KEY), nunca no app.
//
// Por que fetch direto e não o SDK: o plano grátis do Worker dá ~10 ms de processador por pedido, e o print chega
// com 1 a 4 MB em base64. Montar o pedido no SDK copiaria e varreria a imagem inteira em JavaScript; aqui a imagem
// passa direto, em fluxo, do app para a API, só com uma checagem rápida de que é base64 puro (sem aspas nem barra,
// que poderiam mexer no resto do pedido).

const PROJETO = 'infobolsa-investimentos';
const POR_DIA = 30;
const MAX_BYTES = 6 * 1024 * 1024;
const JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

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
// o mesmo texto do robô (dados/prints.mjs), que continua lendo pela fila quando este servidor não responde
const SISTEMA = 'Você lê prints da carteira de investimentos de corretoras brasileiras (posição em ações, FIIs, Fiagros, ETFs e BDRs). '
  + 'Para cada ativo da bolsa que aparecer, devolva o ticker (ex.: PETR4, MXRF11, IVVB11, AAPL34, sem o F do fracionário), a quantidade total e o preço médio por ação ou cota em reais. '
  + 'Se o print não mostrar o preço médio, p é null; não calcule a partir do valor total nem use a cotação atual. '
  + 'Se o mesmo ticker aparecer no fracionário e no lote padrão, some as quantidades e use como preço médio a média ponderada pelas quantidades. Ignore renda fixa, Tesouro, fundos de investimento, cripto e saldo em conta. '
  + 'Marque duvida true quando algum número estiver cortado, borrado ou ambíguo. Se a imagem não for uma carteira de investimentos, e_carteira é false e a lista vem vazia.';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tipo', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ---------- login do Firebase: token JWT assinado pelo Google ----------
let chaves = null, chavesEm = 0;
async function chave(kid) {
  if (!chaves || Date.now() - chavesEm > 3600 * 1000 || !chaves[kid]) {
    const j = await (await fetch(JWKS)).json();
    chaves = {};
    for (const k of j.keys || []) chaves[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    chavesEm = Date.now();
  }
  return chaves[kid];
}
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function usuario(token) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const cab = JSON.parse(new TextDecoder().decode(b64url(h)));
  const dados = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (cab.alg !== 'RS256') return null;
  const k = await chave(cab.kid);
  if (!k || !(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, b64url(s), new TextEncoder().encode(`${h}.${p}`)))) return null;
  const agora = Date.now() / 1000;
  if (dados.aud !== PROJETO || dados.iss !== `https://securetoken.google.com/${PROJETO}` || !(dados.exp > agora) || !dados.sub) return null;
  return dados.sub;
}

const normalizar = (itens) => (itens || [])
  .map((x) => ({ tk: String(x.tk || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]{4}\d{1,2})F$/, '$1'), q: Math.round(Number(x.q) || 0), p: Number(x.p) > 0 ? Math.round(Number(x.p) * 100) / 100 : null, duvida: !!x.duvida }))
  .filter((x) => /^[A-Z]{4}\d{1,2}$/.test(x.tk) && x.q > 0);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/ler') return resposta(404, { erro: 'nao-encontrado' });
    const uid = await usuario((req.headers.get('Authorization') || '').replace(/^Bearer /, '')).catch(() => null);
    if (!uid) return resposta(401, { erro: 'login' });
    const tamanho = Number(req.headers.get('Content-Length'));
    if (!(tamanho > 100)) return resposta(400, { erro: 'vazio' });
    if (tamanho > MAX_BYTES) return resposta(413, { erro: 'grande' });
    const tipo = /^image\/(png|jpeg|webp|gif)$/.test(req.headers.get('X-Tipo') || '') ? req.headers.get('X-Tipo') : 'image/jpeg';

    // limite do dia (horário de Brasília)
    const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const chaveDia = `${uid}:${dia}`;
    const usados = Number(await env.LIMITE.get(chaveDia)) || 0;
    if (usados >= POR_DIA) return resposta(429, { erro: 'limite' });
    await env.LIMITE.put(chaveDia, String(usados + 1), { expirationTtl: 2 * 86400 });

    // o pedido para a API: a imagem entra no meio, em fluxo
    const MARCA = '@@IMAGEM@@';
    const modelo = JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 3000,
      system: SISTEMA,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: tipo, data: MARCA } }, { type: 'text', text: 'Leia as posições deste print.' }] }],
    });
    const [antes, depois] = modelo.split(MARCA).map((t) => new TextEncoder().encode(t));
    const { readable, writable } = new FixedLengthStream(antes.length + tamanho + depois.length);
    let sujo = false;
    const dec = new TextDecoder();
    (async () => {
      const w = writable.getWriter();
      await w.write(antes);
      const r = req.body.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        const t = dec.decode(value, { stream: true });
        if (t.includes('"') || t.includes('\\')) { sujo = true; await w.abort('imagem inválida'); return; }
        await w.write(value);
      }
      await w.write(depois);
      await w.close();
    })().catch(() => {});

    let api;
    try {
      api = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: readable,
      });
    } catch {
      return resposta(sujo ? 400 : 502, { erro: sujo ? 'imagem' : 'ia' });
    }
    if (!api.ok) return resposta(502, { erro: 'ia', status: api.status, detalhe: (await api.text()).slice(0, 300) });
    const r = await api.json();
    if (r.stop_reason !== 'end_turn') return resposta(502, { erro: 'ia', parou: r.stop_reason });
    let j;
    try { j = JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{}'); } catch { return resposta(502, { erro: 'ia' }); }
    return resposta(200, { e_carteira: !!j.e_carteira, itens: j.e_carteira ? normalizar(j.itens) : [] });
  },
};
