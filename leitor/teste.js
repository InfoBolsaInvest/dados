// Só para testar a leitura no wrangler dev --remote, sem o login do app: npx wrangler dev teste.js --remote
import { lerNota } from './src/index.js';
export default { fetch: (req, env) => lerNota(req, env, 'teste') };
