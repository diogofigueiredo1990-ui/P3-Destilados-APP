// ============================================================
// SINCRONIZAR CLIENTES → Firestore
// Cole essa função no mesmo Apps Script das outras
// Document ID = CNPJ (string)
// ============================================================

var SHEET_CLIENTES = "Cadastro de Clientes";
var FIREBASE_COLLECTION_CLI = "clientes";

// Índices das colunas (começa em 0)
var CLI_CNPJ         = 0;
var CLI_CLIENTE      = 1;
var CLI_CAD2         = 2;
var CLI_NOME_EMP     = 3;
var CLI_EMAIL        = 4;
var CLI_TELEFONE     = 5;
var CLI_CONTATO      = 6;
var CLI_CARGO        = 7;
var CLI_CIDADE       = 8;
var CLI_BLOQUEIO     = 9;
var CLI_SCORE        = 10;
var CLI_STATUS       = 11;
var CLI_ORIENTACAO   = 12;
var CLI_BOL_ANAL     = 13;
var CLI_TOT_ABERTO   = 14;
var CLI_TOT_ATRASO   = 15;
var CLI_BOL_ATRASO   = 16;
var CLI_VENDEDOR     = 17;
var CLI_MIX          = 18;
var CLI_FAT_MEDIO    = 19;
var CLI_ULT_ATUALI   = 20;
var CLI_CHAVE        = 21;
var CLI_VENDEDOR_KEY = 33; // coluna AH — Vendedor Responsável (formato exato do app)

function sincronizarClientes() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("⚠️ Outra execução já está em andamento. Abortando.");
    return;
  }

  try {
    let ss;
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
    } catch(e) {
      Logger.log("❌ Erro ao abrir planilha: " + e);
      return;
    }

    const sheet = ss.getSheetByName(SHEET_CLIENTES);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_CLIENTES + "' não encontrada!");
      return;
    }

    const dados = sheet.getDataRange().getValues();
    Logger.log("📊 Clientes na planilha: " + (dados.length - 1));

    const allWrites = [];

    for (let i = 1; i < dados.length; i++) {
      const linha = dados[i];
      const cnpjRaw = linha[CLI_CNPJ];
      if (!cnpjRaw) continue;

      // Normaliza CNPJ como string sem formatação
      const cnpj = String(typeof cnpjRaw === "number"
        ? Math.round(cnpjRaw)
        : cnpjRaw).replace(/\D/g, "");
      if (!cnpj) continue;

      const ultAtuali = linha[CLI_ULT_ATUALI];

      const fields = {
        cnpj:             { stringValue: cnpj },
        cliente:          { stringValue: String(linha[CLI_CLIENTE]    ?? "") },
        cadastro2:        { stringValue: String(linha[CLI_CAD2]       ?? "") },
        nomeEmpresa:      { stringValue: String(linha[CLI_NOME_EMP]   ?? "") },
        email:            { stringValue: String(linha[CLI_EMAIL]      ?? "") },
        telefone:         { stringValue: String(linha[CLI_TELEFONE]   ?? "") },
        contato:          { stringValue: String(linha[CLI_CONTATO]    ?? "") },
        cargo:            { stringValue: String(linha[CLI_CARGO]      ?? "") },
        cidade:           { stringValue: String(linha[CLI_CIDADE]     ?? "") },
        statusBloqueio:   { stringValue: String(linha[CLI_BLOQUEIO]   ?? "") },
        score:            typeof linha[CLI_SCORE] === "number"
                            ? { doubleValue: linha[CLI_SCORE] }
                            : { stringValue: String(linha[CLI_SCORE]  ?? "") },
        status:           { stringValue: String(linha[CLI_STATUS]     ?? "") },
        orientacaoVenda:  { stringValue: String(linha[CLI_ORIENTACAO] ?? "") },
        boletosAnalisados: typeof linha[CLI_BOL_ANAL] === "number"
                            ? { doubleValue: linha[CLI_BOL_ANAL] }
                            : { stringValue: String(linha[CLI_BOL_ANAL] ?? "") },
        totalEmAberto:    typeof linha[CLI_TOT_ABERTO] === "number"
                            ? { doubleValue: linha[CLI_TOT_ABERTO] }
                            : { stringValue: String(linha[CLI_TOT_ABERTO] ?? "") },
        totalEmAtraso:    typeof linha[CLI_TOT_ATRASO] === "number"
                            ? { doubleValue: linha[CLI_TOT_ATRASO] }
                            : { stringValue: String(linha[CLI_TOT_ATRASO] ?? "") },
        boletosPagesAtraso: typeof linha[CLI_BOL_ATRASO] === "number"
                            ? { doubleValue: linha[CLI_BOL_ATRASO] }
                            : { stringValue: String(linha[CLI_BOL_ATRASO] ?? "") },
        vendedorResponsavel: { stringValue: String(linha[CLI_VENDEDOR] ?? "") },
        mixProdutos90d:   { stringValue: String(linha[CLI_MIX]        ?? "") },
        fatMedioMensal90d: typeof linha[CLI_FAT_MEDIO] === "number"
                            ? { doubleValue: linha[CLI_FAT_MEDIO] }
                            : { stringValue: String(linha[CLI_FAT_MEDIO] ?? "") },
        ultimaAtualizacao: ultAtuali instanceof Date
                            ? { stringValue: Utilities.formatDate(ultAtuali, "America/Sao_Paulo", "yyyy-MM-dd") }
                            : { stringValue: String(ultAtuali ?? "") },
        chave:            { stringValue: String(linha[CLI_CHAVE]      ?? "") },
        vendedorKey:      { stringValue: String(linha[CLI_VENDEDOR_KEY] ?? "").trim() },
      };

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + FIREBASE_COLLECTION_CLI + "/" + cnpj,
          fields: fields
        }
      });
    }

    Logger.log("📝 Clientes a enviar: " + allWrites.length);

    const batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                   + "/databases/(default)/documents:batchWrite";
    let sucesso = 0, erro = 0;
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
            sucesso += lote.length;
            Logger.log("✅ Lote " + numLote + "/" + totalLotes + " — total: " + sucesso + "/" + allWrites.length);
            enviado = true;
            break;
          } else {
            Logger.log("⚠️ Lote " + numLote + " tentativa " + tentativa + " — HTTP "
                       + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 200));
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

    Logger.log("✅ Clientes concluído! Sucesso: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}
