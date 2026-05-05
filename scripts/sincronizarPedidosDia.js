// ============================================================
// SINCRONIZAR PEDIDOS DO DIA → Firestore
// Cole essa função no mesmo Apps Script das outras
// Document ID = vendedor_cliente_produto (normalizado)
// Coleção: "pedidosDia"
// ============================================================

var SHEET_PEDIDOS_DIA        = "Pedidos do Dia";
var FIREBASE_COLLECTION_PDD  = "pedidosDia";

// Índices das colunas (começa em 0)
var PDD_VENDEDOR       = 0;
var PDD_CLIENTE        = 1;
var PDD_PRODUTO        = 2;
var PDD_QTD_SUGERIDA   = 3;
var PDD_TENDENCIA      = 4;
var PDD_STATUS_ESTOQUE = 5;
var PDD_RUPTURA        = 6;
var PDD_ULTIMA_COMPRA  = 7;
var PDD_DIAS_SEM       = 8;
var PDD_CONSISTENCIA   = 9;
var PDD_TIPO           = 10;

function normalizar(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // remove acentos
    .replace(/[^a-z0-9]/g, "_")                        // caracteres especiais → _
    .replace(/_+/g, "_")                               // múltiplos _ → um só
    .replace(/^_|_$/g, "");                            // remove _ nas bordas
}

function sincronizarPedidosDia() {
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

    const sheet = ss.getSheetByName(SHEET_PEDIDOS_DIA);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_PEDIDOS_DIA + "' não encontrada!");
      return;
    }

    const dados = sheet.getDataRange().getValues();
    Logger.log("📊 Linhas na aba Pedidos do Dia: " + (dados.length - 1));

    const allWrites = [];

    for (let i = 1; i < dados.length; i++) {
      const linha    = dados[i];
      const vendedor = String(linha[PDD_VENDEDOR] ?? "").trim();
      const cliente  = String(linha[PDD_CLIENTE]  ?? "").trim();
      const produto  = String(linha[PDD_PRODUTO]  ?? "").trim();

      if (!vendedor || !cliente || !produto) continue;

      // ID único por vendedor + cliente + produto
      const docId = normalizar(vendedor) + "_" + normalizar(cliente) + "_" + normalizar(produto);

      const ultimaCompra = linha[PDD_ULTIMA_COMPRA];

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + FIREBASE_COLLECTION_PDD + "/" + encodeURIComponent(docId),
          fields: {
            docId:           { stringValue: docId },
            vendedor:        { stringValue: vendedor },
            cliente:         { stringValue: cliente },
            produto:         { stringValue: produto },
            qtdSugerida:     typeof linha[PDD_QTD_SUGERIDA] === "number"
                               ? { doubleValue: linha[PDD_QTD_SUGERIDA] }
                               : { stringValue: String(linha[PDD_QTD_SUGERIDA] ?? "") },
            tendencia:       { stringValue: String(linha[PDD_TENDENCIA]      ?? "") },
            statusEstoque:   { stringValue: String(linha[PDD_STATUS_ESTOQUE] ?? "") },
            rupturaEstimada: { stringValue: String(linha[PDD_RUPTURA]        ?? "") },
            ultimaCompra:    ultimaCompra instanceof Date
                               ? { stringValue: Utilities.formatDate(ultimaCompra, "America/Sao_Paulo", "yyyy-MM-dd") }
                               : { stringValue: String(ultimaCompra ?? "") },
            diasSemCompra:   typeof linha[PDD_DIAS_SEM] === "number"
                               ? { doubleValue: linha[PDD_DIAS_SEM] }
                               : { stringValue: String(linha[PDD_DIAS_SEM] ?? "") },
            consistenciaDia: { stringValue: String(linha[PDD_CONSISTENCIA]   ?? "") },
            tipo:            { stringValue: String(linha[PDD_TIPO]           ?? "") },
            dataSugestao:    { stringValue: Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd") },
          }
        }
      });
    }

    Logger.log("📝 Registros a enviar: " + allWrites.length);

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

    Logger.log("✅ Pedidos do Dia concluído! Sucesso: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}
