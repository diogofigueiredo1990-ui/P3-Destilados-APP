import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 60, memory: 512 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { arquivos, arquivoBase64, mimeType, url, nomeCliente, historico, catalogo } = req.body;

  if ((!arquivos?.length && !arquivoBase64 && !url) || !historico) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const historicoTexto = formatarHistorico(historico);
  const catalogoTexto  = formatarCatalogo(catalogo);

  const systemPrompt = `Você é um consultor de vendas especializado em bebidas e insumos para restaurantes da empresa P3 Destilados.
Seu objetivo é analisar o cardápio de um cliente e identificar oportunidades de venda dos produtos P3.

CATÁLOGO COMPLETO DA P3 DESTILADOS (use para confirmar que vendemos o ingrediente):
${catalogoTexto}

REGRA FUNDAMENTAL — como nomear o campo "ingrediente":
- Produtos SEM sabor/diferenciação (destilados base, cerveja, vinho sem especificação): use APENAS o tipo genérico. Ex: "Vodka", "Gin", "Cachaça", "Rum", "Whisky", "Tequila", "Cerveja", "Vinho Rosé". NUNCA cite marca ou SKU.
- Produtos COM sabor ou característica específica: use tipo + sabor/característica. Ex: "Xarope de Morango", "Xarope de Limão Siciliano", "Xarope de Cranberry", "Licor de Amora", "Vinho Espumante". NUNCA cite marca ou SKU.
- Cada ingrediente genérico deve aparecer UMA SÓ VEZ — agrupe todos os drinks que usam vodka em uma única oportunidade "Vodka".

INSTRUÇÕES:
1. Leia todo o cardápio e mapeie TODOS os ingredientes usados nos drinks/pratos

2. Para cada ingrediente, PRIMEIRO verifique se existe equivalente no CATÁLOGO P3 acima:
   - SE EXISTE no catálogo → vai para "oportunidades"
   - SE NÃO EXISTE no catálogo → vai para "naoVendemos" (NUNCA coloque em oportunidades)
   Esta regra é ABSOLUTA: um ingrediente só entra em "oportunidades" se a P3 tiver algo equivalente para vender.

3. Para os itens em "oportunidades", classifique cruzando com o histórico:
   - ATIVO: cliente compra esse tipo/sabor nos últimos 90 dias
   - RECUPERACAO: comprou antes mas parou há mais de 90 dias (campo "PRODUTOS INATIVOS")
   - NOVO: nunca comprou esse tipo/sabor da P3 (mas P3 tem no catálogo)

   COMO FAZER O MATCH COM O HISTÓRICO:
   O histórico contém nomes completos de SKU como "VODKA BACCO SPIRIT 750ML [Categoria: Vodka]".
   Use a [Categoria] quando disponível — ela é o tipo genérico do produto.
   Se não houver [Categoria], interprete o nome do produto: "VODKA BACCO" → Vodka, "XAROPE MORANGO MONIN" → Xarope de Morango, etc.
   Um ingrediente é ATIVO se qualquer produto do histórico ATIVO corresponder ao mesmo tipo/sabor genérico.
   Um ingrediente é RECUPERACAO se aparecer apenas em PRODUTOS INATIVOS.

4. Liste no "itensCardapio" os drinks/pratos que usam cada ingrediente

Responda APENAS com JSON válido (sem markdown, sem texto fora do JSON):
{
  "itensCardapio": ["lista de drinks/pratos encontrados no cardápio"],
  "oportunidades": [
    {
      "ingrediente": "tipo genérico ou tipo+sabor (ex: Vodka | Xarope de Morango)",
      "categoria": "categoria P3 (ex: Vodka | Xarope | Gin)",
      "status": "ATIVO|RECUPERACAO|NOVO",
      "itemCardapio": "primeiro drink que usa este ingrediente",
      "produtosHistorico": ["nomes do histórico se ATIVO ou RECUPERACAO"],
      "motivo": "máximo 10 palavras explicando a oportunidade"
    }
  ],
  "naoVendemos": ["ingredientes que o cliente usa mas que NÃO estão no catálogo P3 — tipo genérico, sem marca"],
  "resumo": "2-3 frases resumindo as principais oportunidades"
}`;

  const totalArquivos = arquivos?.length || (arquivoBase64 ? 1 : 0);
  const userMessage = `Cliente: ${nomeCliente}

HISTÓRICO DE COMPRAS DO CLIENTE NA P3:
${historicoTexto}

Analise o${totalArquivos > 1 ? `s ${totalArquivos} arquivos do` : ''} cardápio abaixo e identifique as oportunidades de venda:`;

  try {
    let contentBlocks;

    if (url) {
      const fetchRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; P3Destilados/1.0)' },
        redirect: 'follow',
      });

      if (!fetchRes.ok) {
        return res.status(422).json({ error: `Não foi possível acessar a URL (status ${fetchRes.status}). Verifique se o link é público.` });
      }

      const contentType = fetchRes.headers.get('content-type') || '';

      if (contentType.includes('application/pdf')) {
        const buffer = await fetchRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        contentBlocks = [
          { type: 'text', text: userMessage },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        ];
      } else if (contentType.startsWith('image/')) {
        const buffer = await fetchRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const imgMime = contentType.split(';')[0].trim();
        contentBlocks = [
          { type: 'text', text: userMessage },
          { type: 'image', source: { type: 'base64', media_type: imgMime, data: base64 } },
        ];
      } else {
        const html = await fetchRes.text();
        const textoLimpo = extrairTextoHtml(html);
        if (textoLimpo.length < 50) {
          return res.status(422).json({ error: 'A página não contém texto suficiente para análise. Tente usar a foto ou PDF do cardápio.' });
        }
        contentBlocks = [
          { type: 'text', text: `${userMessage}\n\n---\nCONTEÚDO DO CARDÁPIO (extraído de ${url}):\n\n${textoLimpo.slice(0, 15000)}` },
        ];
      }
    } else {
      const lista = arquivos?.length ? arquivos : [{ base64: arquivoBase64, mimeType }];
      const blocos = lista.map(f => {
        if (f.mimeType === 'application/pdf') {
          return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } };
        }
        return { type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.base64 } };
      });
      contentBlocks = [{ type: 'text', text: userMessage }, ...blocos];
    }

    // Prefill com '{' força JSON puro sem texto introdutório
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        { role: 'user',      content: contentBlocks },
        { role: 'assistant', content: '{'           },
      ],
    });

    // Recoloca o '{' do prefill que não vem na resposta
    const texto = '{' + (message.content[0]?.text || '');

    let resultado;
    try {
      resultado = JSON.parse(texto);
    } catch {
      // Fallback: extrai bloco JSON com regex
      const m = texto.match(/\{[\s\S]*\}/);
      if (!m) return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      try {
        resultado = JSON.parse(m[0]);
      } catch {
        return res.status(500).json({ error: 'Não foi possível interpretar a resposta da IA. Tente com menos arquivos ou uma imagem mais simples.' });
      }
    }

    return res.status(200).json(resultado);
  } catch (err) {
    console.error('Erro diagnostico:', err);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}

function extrairTextoHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .trim();
}

function formatarCatalogo(catalogo) {
  if (!catalogo || !catalogo.length) return 'Catálogo não disponível.';

  const porCategoria = {};
  catalogo.forEach(p => {
    const cat = p.categoria || 'Outros';
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(p.nomeProduto);
  });

  return Object.entries(porCategoria)
    .map(([cat, produtos]) => `${cat}:\n${produtos.map(p => `  - ${p}`).join('\n')}`)
    .join('\n\n');
}

function formatarHistorico(historico) {
  if (!historico || !historico.length) return 'Nenhuma compra registrada.';

  const ativos   = historico.filter(h => h.status === 'ATIVO');
  const inativos = historico.filter(h => h.status === 'INATIVO');
  let texto = '';

  if (ativos.length) {
    texto += 'PRODUTOS ATIVOS (comprou nos últimos 90 dias):\n';
    ativos.forEach(h => {
      const cat = h.categoria ? ` [Categoria: ${h.categoria}]` : '';
      texto += `  - ${h.produto}${cat} | Última compra: ${h.ultimaCompra} | Total: R$ ${Number(h.totalFat || 0).toFixed(2)}\n`;
    });
  }

  if (inativos.length) {
    texto += '\nPRODUTOS INATIVOS (parou de comprar há mais de 90 dias):\n';
    inativos.forEach(h => {
      const cat = h.categoria ? ` [Categoria: ${h.categoria}]` : '';
      texto += `  - ${h.produto}${cat} | Última compra: ${h.ultimaCompra} | Total histórico: R$ ${Number(h.totalFat || 0).toFixed(2)}\n`;
    });
  }

  return texto || 'Nenhuma compra registrada.';
}
