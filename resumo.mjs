// Resumo do fechamento (1x por dia de pregão, na rodada das 18h30): números do dia + manchetes do mercado
// vão para o Claude Haiku, que escreve em poucas frases por que a bolsa, o dólar, o IFIX e o exterior se
// mexeram. Os números quem põe é o app (vêm do mercado.json); a IA só explica, e só com o que está nas
// manchetes. Nada de recomendação de compra ou venda.
// Publica site/resumo.json. Fora do horário, ou se já saiu o de hoje, só repõe o publicado.
// RESUMO=1 faz de novo na hora (teste). Sem ANTHROPIC_API_KEY, não faz e mantém o anterior.
import { readFileSync, writeFileSync } from 'node:fs';

const brt = new Date(Date.now() - 3 * 3600 * 1000);
const hoje = brt.toISOString().slice(0, 10);
const minutos = brt.getUTCHours() * 60 + brt.getUTCMinutes();
const forcar = process.env.RESUMO === '1';
const ler = (f) => JSON.parse(readFileSync(`site/${f}`, 'utf8'));

// o publicado continua no site enquanto não sair um novo
let anterior = null;
try { anterior = await (await fetch('https://infobolsainvest.github.io/dados/resumo.json')).json(); } catch {}
const manter = (motivo) => {
  if (anterior?.d) writeFileSync('site/resumo.json', JSON.stringify(anterior));
  console.log(`resumo do fechamento: ${motivo}`);
  process.exit(0);
};
if (!forcar && anterior?.d === hoje) manter('o de hoje já saiu');

const mercado = ler('mercado.json');
const diaMercado = mercado.atualizadoEm ? new Date(new Date(mercado.atualizadoEm).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) : '';
const feriado = (() => { try { return ler('calendario.json').some((e) => e.d === hoje && /Sem pregão/.test(e.t)); } catch { return false; } })();
const pregao = brt.getUTCDay() % 6 !== 0 && !feriado && diaMercado === hoje;
if (!forcar && (minutos < 18 * 60 + 30 || !pregao)) manter(pregao ? 'só depois das 18h30' : 'hoje não teve pregão');
if (!process.env.ANTHROPIC_API_KEY) manter('falta ANTHROPIC_API_KEY');
if (!mercado.ibov) manter('sem o Ibovespa de hoje');

// ---------- o que a IA recebe ----------
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}%`;
const cot = ler('cotacoes.json').q;
const cat = ler('catalogo.json').a;
// maiores altas e baixas entre as 100 ações mais negociadas (igual ao app)
const top = Object.keys(cot).filter((tk) => cat[tk]?.[1] === 'acao').sort((a, b) => (cat[b][4] || 0) - (cat[a][4] || 0)).slice(0, 100);
const porVar = top.filter((tk) => cot[tk]).sort((a, b) => cot[b][1] - cot[a][1]);
const altas = porVar.slice(0, 3).map((tk) => `${tk} (${cat[tk][0]}) ${pct(cot[tk][1])}`);
const baixas = porVar.slice(-3).reverse().map((tk) => `${tk} (${cat[tk][0]}) ${pct(cot[tk][1])}`);
const fora = Object.entries({ 'S&P 500': 'SPX', Nasdaq: 'NASDAQ', 'Dow Jones': 'DOW' })
  .filter(([, k]) => mercado.mundo?.[k]).map(([n, k]) => `${n} ${pct(mercado.mundo[k][1])}`);
const manchetes = (ler('noticias.json').n || []).filter((x) => x.d === hoje).slice(0, 40).map((x) => `- ${x.ti} (${x.f}, ${x.h})`);

const dados = [
  `Data: ${hoje}`,
  `Ibovespa: ${Math.round(mercado.ibov[0]).toLocaleString('pt-BR')} pontos, ${pct(mercado.ibov[1])}`,
  mercado.dolar ? `Dólar: R$ ${mercado.dolar[0].toFixed(2).replace('.', ',')}, ${pct(mercado.dolar[1])}` : '',
  mercado.ifix ? `IFIX: ${pct(mercado.ifix[1])}` : '',
  fora.length ? `Exterior: ${fora.join(', ')}` : '',
  `Maiores altas (entre as 100 ações mais negociadas): ${altas.join('; ')}`,
  `Maiores baixas: ${baixas.join('; ')}`,
  '',
  'Manchetes de hoje:',
  ...manchetes,
].filter((l) => l !== '').join('\n');

// MOSTRAR=1: só mostra o que iria pra IA (teste sem gastar)
if (process.env.MOSTRAR === '1') { console.log(dados); process.exit(0); }

const SISTEMA = `Você escreve o resumo do fechamento do mercado para o app InfoBolsa, para investidores pessoa física, em português do Brasil simples.
Regras:
- Use só os números e as manchetes que vieram na mensagem. Não invente motivos, números nem fatos.
- Se as manchetes não explicam um movimento, diga isso com naturalidade (ex.: "sem um motivo claro nas notícias do dia").
- Nunca recomende comprar, vender ou manter nada, nem diga o que vai acontecer. Só relate o que aconteceu.
- Frases curtas. Nada de travessão (— ou –): use vírgula ou ponto.
- Não repita os números de pontos e porcentagens: o app já mostra. Foque no porquê.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    manchete: { type: 'string', description: 'Uma frase de até 90 caracteres que resume o dia' },
    ibovespa: { type: 'string', description: 'Até 2 frases: por que o Ibovespa subiu ou caiu, citando as ações que mais pesaram se fizer sentido' },
    dolar: { type: 'string', description: 'Até 2 frases sobre o dólar; vazio se não houver dado' },
    ifix: { type: 'string', description: 'Até 2 frases sobre os fundos imobiliários; vazio se não houver dado' },
    exterior: { type: 'string', description: 'Até 2 frases sobre as bolsas de fora; vazio se não houver dado' },
  },
  required: ['manchete', 'ibovespa', 'dolar', 'ifix', 'exterior'],
  additionalProperties: false,
};

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic();
let r;
try {
  r = await client.messages.create({
    model: 'claude-haiku-5-5', // o mais barato: o dono pediu um modelo básico e esforço baixo
    max_tokens: 2000,
    system: SISTEMA,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: dados }],
  });
} catch (e) {
  if (e instanceof Anthropic.APIError) { console.log(`resumo: a API respondeu ${e.status}: ${e.message}`); }
  else console.log(`resumo: ${e.message}`);
  if (anterior?.d) writeFileSync('site/resumo.json', JSON.stringify(anterior));
  process.exit(1); // passo vermelho: o aviso do Telegram conta
}
if (r.stop_reason !== 'end_turn') {
  console.log(`resumo: parou com ${r.stop_reason}`);
  if (anterior?.d) writeFileSync('site/resumo.json', JSON.stringify(anterior));
  process.exit(1);
}
const texto = r.content.find((b) => b.type === 'text')?.text || '';
const j = JSON.parse(texto);
// travessão nunca: troca por vírgula se escapar
const limpo = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ').trim();
const resumo = {
  d: hoje,
  em: new Date().toISOString(),
  manchete: limpo(j.manchete),
  itens: [
    { k: 'ibov', nome: 'Ibovespa', n: mercado.ibov, t: limpo(j.ibovespa) },
    mercado.dolar ? { k: 'dolar', nome: 'Dólar', n: mercado.dolar, t: limpo(j.dolar) } : null,
    mercado.ifix ? { k: 'ifix', nome: 'IFIX', n: mercado.ifix, t: limpo(j.ifix) } : null,
    fora.length ? { k: 'exterior', nome: 'Lá fora', n: mercado.mundo?.SPX || null, t: limpo(j.exterior) } : null,
  ].filter((x) => x && x.t),
};
writeFileSync('site/resumo.json', JSON.stringify(resumo));
console.log(`ok: resumo do fechamento (${r.usage.input_tokens} tokens de entrada, ${r.usage.output_tokens} de saída)`);
