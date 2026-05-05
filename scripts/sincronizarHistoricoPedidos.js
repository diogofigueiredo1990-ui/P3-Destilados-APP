// ============================================================
// SINCRONIZAR HISTÓRICO DE PEDIDOS → Firestore
// Coleção: "pedidos"
//
// Estratégia:
//   1) Deleta TODOS os documentos existentes na coleção
//   2) Reinsere tudo da aba "Histórico de Pedidos"
//
// Rode diariamente (ex: às 3h)
// ============================================================

const FIREBASE_PROJECT_ID = "cafirestore2";
const FIREBASE_COLLECTION = "pedidos";
const SHEET_SYNC_NAME     = "Histórico de Pedidos";
const SPREADSHEET_ID_FB   = "1V-RhlYnl9TDqj9MW0UwJWeZbNSREg5x-vIZAWdTwUcE";
const BATCH_SIZE          = 500;
const MAX_RETRIES         = 3;

const COLUNAS_FB = [
  "estado", "contaAzul", "cliente", "cnpj", "dataVenda",          // A-E  (0-4)
  "vendedor", "cidade", "bairro", "endereco", "complemento",       // F-J  (5-9)
  "telefone", "produto", "precoUnitario", "quantidadeProdutos",    // K-N  (10-13)
  "situacao", "metodoPagamento", "formaPagamento", "chave",        // O-R  (14-17)
  "numeroVenda",                                                   // S    (18)
  "codigoProduto",                                                 // T    (19)
  "faturamento", "percentComissao", "comissao",                    // U-W  (20-22)
  "fornecedor", "categoriaProduto", "ano", "mes",                  // X-AA (23-26)
  "percentMargemContribuicao", "margemContribuicao",               // AB-AC (27-28)
  "primeiraCompra", "ultimaCompra", "diasSemCompra",               // AD-AF (29-31)
  "pontuacao",                                                     // AG    (32)
  "vendedorResponsavel",                                           // AH    (33)
];

// ── DELETAR TODA A COLEÇÃO (paginado) ────────────────────────
// A API REST não tem "deletar coleção" — precisa listar e deletar em lotes.

function deletarColecaoPedidos() {
  const listBase = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                 + "/databases/(default)/documents/" + FIREBASE_COLLECTION;
  const batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                 + "/databases/(default)/documents:batchWrite";

  let totalDeletados = 0;
  let pageToken = null;

  Logger.log("🗑️ Iniciando deleção da coleção '" + FIREBASE_COLLECTION + "'...");

  do {
    // Lista até 300 documentos por vez (máximo da API)
    let listUrl = listBase + "?pageSize=300&fields=documents.name,nextPageToken";
    if (pageToken) listUrl += "&pageToken=" + encodeURIComponent(pageToken);

    const listResp = UrlFetchApp.fetch(listUrl, {
      method: "GET",
      headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (listResp.getResponseCode() !== 200) {
      Logger.log("❌ Erro ao listar documentos: " + listResp.getContentText().slice(0, 300));
      break;
    }

    const resultado = JSON.parse(listResp.getContentText());
    const docs = resultado.documents || [];
    pageToken = resultado.nextPageToken || null;

    if (!docs.length) break;

    // Deleta em lotes de BATCH_SIZE
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const lote = docs.slice(i, i + BATCH_SIZE).map(d => ({ delete: d.name }));

      const delResp = UrlFetchApp.fetch(batchUrl, {
        method: "POST",
        contentType: "application/json",
        headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({ writes: lote }),
        muteHttpExceptions: true
      });

      if (delResp.getResponseCode() === 200) {
        totalDeletados += lote.length;
      } else {
        Logger.log("⚠️ Erro ao deletar lote: " + delResp.getContentText().slice(0, 200));
      }
      Utilities.sleep(200);
    }

    Logger.log("🗑️ Deletados até agora: " + totalDeletados);

  } while (pageToken);

  Logger.log("✅ Deleção concluída: " + totalDeletados + " documentos removidos.");
  return totalDeletados;
}

// ── SINCRONIZAÇÃO PRINCIPAL ───────────────────────────────────

function sincronizarFirebase() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("⚠️ Outra execução já está em andamento. Abortando.");
    return;
  }

  try {

    // 1. Abre a planilha
    let ss, sheet;
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
    } catch(e) {
      Logger.log("❌ Erro ao abrir planilha (verifique o SPREADSHEET_ID_FB): " + e);
      return;
    }
    sheet = ss.getSheetByName(SHEET_SYNC_NAME);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_SYNC_NAME + "' não encontrada!");
      Logger.log("📋 Abas disponíveis: " + ss.getSheets().map(s => s.getName()).join(", "));
      return;
    }

    const dados = sheet.getDataRange().getValues();
    Logger.log("📊 Linhas na planilha: " + (dados.length - 1));

    // 2. ── DELETA TODA A COLEÇÃO ANTES DE REINSERIR ──────────
    deletarColecaoPedidos();

    // 3. Monta documentos — usa Map para deduplicar chaves repetidas (última linha vence)
    const writesMap = new Map();
    for (let i = 1; i < dados.length; i++) {
      const linha = dados[i];
      const docId = String(linha[17] ?? "");
      if (!docId || docId === "undefined") continue;

      const fields = {};
      COLUNAS_FB.forEach((campo, idx) => {
        const val = linha[idx];
        if (val instanceof Date) {
          fields[campo] = { stringValue: Utilities.formatDate(val, "America/Sao_Paulo", "yyyy-MM-dd") };
        } else if (typeof val === "number") {
          fields[campo] = { doubleValue: val };
        } else {
          fields[campo] = { stringValue: String(val ?? "") };
        }
      });

      writesMap.set(docId, {
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + FIREBASE_COLLECTION + "/" + encodeURIComponent(docId),
          fields: fields
        }
      });
    }

    const allWrites = [...writesMap.values()];
    const duplicatas = (dados.length - 1) - allWrites.length;
    if (duplicatas > 0) Logger.log("⚠️ " + duplicatas + " linhas com chave duplicada ignoradas (última vence).");
    Logger.log("📝 Documentos a inserir: " + allWrites.length);

    // 4. Envia em lotes com retry
    const batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                   + "/databases/(default)/documents:batchWrite";
    let sucesso = 0;
    let erro    = 0;
    const totalLotes = Math.ceil(allWrites.length / BATCH_SIZE);

    for (let i = 0; i < allWrites.length; i += BATCH_SIZE) {
      const lote    = allWrites.slice(i, i + BATCH_SIZE);
      const numLote = Math.floor(i / BATCH_SIZE) + 1;
      let enviado   = false;

      for (let tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
        const token = ScriptApp.getOAuthToken();
        try {
          const resp = UrlFetchApp.fetch(batchUrl, {
            method: "POST",
            contentType: "application/json",
            headers: { "Authorization": "Bearer " + token },
            payload: JSON.stringify({ writes: lote }),
            muteHttpExceptions: true
          });

          if (resp.getResponseCode() === 200) {
            try {
              const result = JSON.parse(resp.getContentText());
              const writeResults = result.writeResults || [];
              let errosParciais = 0;
              writeResults.forEach((wr, idx) => {
                if (wr.status && wr.status.code && wr.status.code !== 0) {
                  errosParciais++;
                  const docId = lote[idx]?.update?.name?.split("/").pop() || idx;
                  Logger.log("⚠️ Falha parcial no doc '" + docId + "': " + JSON.stringify(wr.status));
                }
              });
              sucesso += lote.length - errosParciais;
              erro    += errosParciais;
              if (errosParciais > 0) {
                Logger.log("⚠️ Lote " + numLote + "/" + totalLotes + " — " + errosParciais + " falha(s) parcial(is)");
              } else {
                Logger.log("✅ Lote " + numLote + "/" + totalLotes + " — total: " + sucesso + "/" + allWrites.length);
              }
            } catch(parseErr) {
              sucesso += lote.length;
              Logger.log("✅ Lote " + numLote + "/" + totalLotes + " — total: " + sucesso + "/" + allWrites.length);
            }
            enviado = true;
            break;
          } else {
            Logger.log("⚠️ Lote " + numLote + " tentativa " + tentativa + " — HTTP "
                       + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
            if (tentativa < MAX_RETRIES) Utilities.sleep(2000 * tentativa);
          }
        } catch(e) {
          Logger.log("⚠️ Lote " + numLote + " tentativa " + tentativa + " — exceção: " + e);
          if (tentativa < MAX_RETRIES) Utilities.sleep(2000 * tentativa);
        }
      }

      if (!enviado) {
        erro += lote.length;
        Logger.log("❌ Lote " + numLote + " falhou após " + MAX_RETRIES + " tentativas.");
      }
      Utilities.sleep(300);
    }

    Logger.log("✅ Concluído! Inseridos: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}

// ── UTILITÁRIOS ───────────────────────────────────────────────

function encontrarDuplicatas() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
  const sheet = ss.getSheetByName(SHEET_SYNC_NAME);
  const dados = sheet.getDataRange().getValues();
  const visto = {};
  const duplas = [];
  for (let i = 1; i < dados.length; i++) {
    const chave = String(dados[i][17] || "");
    if (!chave) continue;
    if (visto[chave] === undefined) {
      visto[chave] = i + 1;
    } else {
      const existente = duplas.find(d => d.chave === chave);
      if (existente) existente.linhas.push(i + 1);
      else duplas.push({ chave, linhas: [visto[chave], i + 1] });
    }
  }
  if (!duplas.length) { Logger.log("✅ Nenhuma duplicata encontrada."); return; }
  Logger.log("⚠️ " + duplas.length + " chaves duplicadas:");
  duplas.forEach(d => Logger.log("  Chave: " + d.chave + " | Linhas: " + d.linhas.join(", ")));
}

function removerDuplicatas() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
  const sheet = ss.getSheetByName(SHEET_SYNC_NAME);
  const dados = sheet.getDataRange().getValues();
  const visto = new Set();
  const linhasApagar = [];
  for (let i = 1; i < dados.length; i++) {
    const chave = String(dados[i][17] || "");
    if (!chave) continue;
    if (visto.has(chave)) linhasApagar.push(i + 1);
    else visto.add(chave);
  }
  if (!linhasApagar.length) { Logger.log("✅ Nenhuma duplicata encontrada."); return; }
  Logger.log("🗑️ Removendo " + linhasApagar.length + " linhas...");
  linhasApagar.reverse().forEach(row => sheet.deleteRow(row));
  SpreadsheetApp.flush();
  Logger.log("✅ " + linhasApagar.length + " linhas removidas. Rode sincronizarFirebase() agora.");
}

function criarTriggerDiario() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "sincronizarFirebase") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sincronizarFirebase")
    .timeBased().everyDays(1).atHour(3)
    .inTimezone("America/Sao_Paulo").create();
  Logger.log("⏰ Trigger criado: todo dia às 3h (Brasília).");
}

function removerTriggerDiario() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "sincronizarFirebase") ScriptApp.deleteTrigger(t);
  });
  Logger.log("🗑️ Trigger removido.");
}
