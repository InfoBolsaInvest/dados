// Leitor de notas de corretagem (Cloudflare Worker, plano grátis): o app manda o PDF da nota (padrão Sinacor, o da
// B3) e recebe na hora as compras e vendas com data, preço e taxas. Fluxo: confere o login do Firebase (token do
// usuário), conta o limite do dia (200 leituras por pessoa, no KV LIMITE), manda o PDF para o Claude Haiku e devolve
// { e_nota, notas }. A chave da Anthropic fica só aqui, como segredo do Worker (ANTHROPIC_NOTAS_KEY), nunca no app.
// Da nota só voltam as operações e os custos: nome, CPF e endereço do cliente não saem daqui nem ficam guardados.
//
// Por que fetch direto e não o SDK: o plano grátis do Worker dá ~10 ms de processador por pedido. Montar o pedido no
// SDK copiaria e varreria o PDF inteiro em JavaScript; aqui o arquivo passa direto, em fluxo, do app para a API, só
// com uma checagem rápida de que é base64 puro (sem aspas nem barra, que poderiam mexer no resto do pedido).

const PROJETO = 'infobolsa-investimentos';
const POR_DIA = 200; // leituras por dia (o app manda o PDF grande em partes de 15 páginas)
const MAX_BYTES = 8 * 1024 * 1024;
const JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const NUM = { type: 'number' };
const ESQUEMA = {
  type: 'object',
  properties: {
    e_nota: { type: 'boolean' },
    notas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'string' },
          d: { type: 'string' },
          compras: NUM,
          vendas: NUM,
          custos: NUM,
          irrf: NUM,
          outros: { type: 'boolean' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cv: { type: 'string', enum: ['C', 'V'] },
                esp: { type: 'string' },
                tk: { type: 'string' },
                deduzido: { type: 'boolean' },
                q: NUM,
                p: NUM,
                vl: NUM,
                dt: { type: 'boolean' },
              },
              required: ['cv', 'esp', 'tk', 'deduzido', 'q', 'p', 'vl', 'dt'],
              additionalProperties: false,
            },
          },
        },
        required: ['n', 'd', 'compras', 'vendas', 'custos', 'irrf', 'outros', 'ops'],
        additionalProperties: false,
      },
    },
  },
  required: ['e_nota', 'notas'],
  additionalProperties: false,
};
const SISTEMA = 'Você lê notas de corretagem (nota de negociação) da bolsa brasileira, no padrão Sinacor da B3. Para cada nota do PDF, devolva:\n'
  + '- n: o Nr. nota. d: a Data pregão, em aaaa-mm-dd.\n'
  + '- compras e vendas: só os valores das linhas "Compras à vista" e "Vendas à vista" do Resumo dos Negócios (opções e termo têm linhas próprias e não entram).\n'
  + '- custos: o total de custos e taxas da nota em reais (taxa de liquidação, taxa de registro, emolumentos, taxa de termo ou opções, taxa A.N.A., corretagem, ISS, impostos e outras), sem o I.R.R.F.\n'
  + '- irrf: o I.R.R.F. sobre operações (0 se não houver).\n'
  + '- ops: cada linha de "Negócios realizados" do mercado VISTA ou FRACIONARIO. cv: C ou V. esp: a especificação do título como está na nota. '
  + 'tk: o ticker (ex.: HGRU11, PETR4, BOVA11, AAPL34; no fracionário, sem o F do final). Quando a nota trouxer só o nome (ex.: PETROBRAS PN N2), deduza o ticker pelo nome e pela classe (ON = 3, PN = 4, PNA = 5, PNB = 6, UNT = 11) e marque deduzido true. '
  + 'q: a quantidade. p: o preço. vl: o valor da operação. dt: true quando a coluna Obs. tiver D (day trade).\n'
  + '- outros: true se a nota tiver operações fora do mercado à vista (opções, termo, futuro). Essas não entram em ops.\n'
  + 'Uma nota pode ter várias folhas com o mesmo Nr. nota: junte tudo em uma só. Leia todas as linhas de todas as folhas, inclusive as repetidas: cada linha é uma operação, mesmo que seja igual à de cima. '
  + 'Antes de responder, confira se a soma dos valores das compras bate com "Compras à vista" (e a das vendas com "Vendas à vista"); se não bater, procure a linha que faltou. Copie os números exatamente como estão na nota. '
  + 'Se o arquivo não for uma nota de corretagem, e_nota é false e notas vem vazia.';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
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

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const normalizar = (notas) => (notas || [])
  .map((x) => ({
    n: String(x.n || '').replace(/\D/g, ''),
    d: /^\d{4}-\d{2}-\d{2}$/.test(x.d) ? x.d : '',
    compras: cent(x.compras), vendas: cent(x.vendas), custos: cent(x.custos), irrf: cent(x.irrf), outros: !!x.outros,
    ops: (x.ops || []).map((o) => ({
      cv: o.cv === 'V' ? 'V' : 'C',
      esp: String(o.esp || '').slice(0, 60),
      tk: String(o.tk || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z0-9]{4}\d{1,2})F$/, '$1'),
      deduzido: !!o.deduzido,
      q: Math.round(Number(o.q) || 0), p: Number(o.p) || 0, vl: cent(o.vl), dt: !!o.dt,
    })).filter((o) => o.q > 0),
  }))
  .filter((x) => x.n && x.d);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/nota') return resposta(404, { erro: 'nao-encontrado' });
    const uid = await usuario((req.headers.get('Authorization') || '').replace(/^Bearer /, '')).catch(() => null);
    if (!uid) return resposta(401, { erro: 'login' });
    return lerNota(req, env, uid);
  },
};

// separado do login para dar para testar (teste.js, só no wrangler dev)
export async function lerNota(req, env, uid) {
  const tamanho = Number(req.headers.get('Content-Length'));
  if (!(tamanho > 100)) return resposta(400, { erro: 'vazio' });
  if (tamanho > MAX_BYTES) return resposta(413, { erro: 'grande' });

  // limite do dia (horário de Brasília)
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const chaveDia = `nota:${uid}:${dia}`;
  const usados = Number(await env.LIMITE.get(chaveDia)) || 0;
  if (usados >= POR_DIA) return resposta(429, { erro: 'limite' });
  await env.LIMITE.put(chaveDia, String(usados + 1), { expirationTtl: 2 * 86400 });

  // o pedido para a API: o PDF entra no meio, em fluxo
  const MARCA = '@@PDF@@';
  const modelo = JSON.stringify({
    model: 'claude-haiku-5-5',
    max_tokens: 32000,
    system: SISTEMA,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: MARCA } }, { type: 'text', text: 'Leia as notas deste PDF.' }] }],
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
      if (t.includes('"') || t.includes('\\')) { sujo = true; await w.abort('arquivo inválido'); return; }
      await w.write(value);
    }
    await w.write(depois);
    await w.close();
  })().catch(() => {});

  let api;
  try {
    api = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_NOTAS_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: readable,
    });
  } catch {
    return resposta(sujo ? 400 : 502, { erro: sujo ? 'arquivo' : 'ia' });
  }
  if (!api.ok) {
    const detalhe = (await api.text()).slice(0, 400);
    // PDF com senha ou páginas demais: a API recusa com 400
    const erro = api.status === 400 && /password|encrypt/i.test(detalhe) ? 'senha' : api.status === 400 && /page/i.test(detalhe) ? 'paginas' : api.status === 400 ? 'pdf' : 'ia';
    return resposta(502, { erro, status: api.status, detalhe: detalhe.slice(0, 300) });
  }
  const r = await api.json();
  if (r.stop_reason !== 'end_turn') return resposta(502, { erro: r.stop_reason === 'max_tokens' ? 'paginas' : 'ia', parou: r.stop_reason });
  let j;
  try { j = JSON.parse(r.content.find((b) => b.type === 'text')?.text || '{}'); } catch { return resposta(502, { erro: 'ia' }); }
  return resposta(200, { e_nota: !!j.e_nota, notas: j.e_nota ? normalizar(j.notas) : [], uso: { ent: r.usage?.input_tokens, sai: r.usage?.output_tokens } });
}
