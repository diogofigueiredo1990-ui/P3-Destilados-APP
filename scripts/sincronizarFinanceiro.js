// ============================================================
// SINCRONIZAR FINANCEIRO (boletos) → Firestore
// Cole essa função no mesmo Apps Script do sincronizarFirebase
// Versão 2: agrupa por contaAzul + numeroVenda
// ============================================================

var SHEET_FINANCEIRO = "Financeiro";
var FIREBASE_COLLECTION_FIN = "financeiro";

// Índices das colunas da aba Financeiro (começa em 0)
// A=0  B=1  C=2  D=3  E=4  F=5  G=6  H=7  I=8  J=9  K=10  L=11  M=12  N=13
var IDX_ESTADO     = 0;
var IDX_CONTAAZUL  = 1;
var IDX_NUMVENDA   = 2;
var IDX_CNPJ       = 3;
var IDX_CLIENTE    = 4;
var IDX_VALOR_ORI  = 5;
var IDX_JUROS      = 6;
var IDX_VENCIMENTO = 7;
var IDX_STATUS     = 8;
var IDX_VALOR_PAGO = 9;
var IDX_EM_ABERTO  = 10;
var IDX_DIAS_ATR   = 11;
var IDX_CHAVE      = 12;
var IDX_COM_BLOQ   = 13; // N — Comissão Bloqueada

function sincronizarFinanceiro() {
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

    const sheet = ss.getSheetByName(SHEET_FINANCEIRO);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_FINANCEIRO + "' não encontrada!");
      return;
    }

    const dados = sheet.getDataRange().getValues();
    Logger.log("📊 Linhas na aba Financeiro: " + (dados.length - 1));

    // Agrupa boletos por contaAzul + numeroVenda (ex: "DF1_1000")
    const porVenda = {};
    for (let i = 1; i < dados.length; i++) {
      const linha      = dados[i];
      const contaAzul  = String(linha[IDX_CONTAAZUL] ?? "").trim();
      const numeroVenda = String(linha[IDX_NUMVENDA] ?? "").trim();
      if (!contaAzul || !numeroVenda) continue;

      const docId = contaAzul + "_" + numeroVenda;

      if (!porVenda[docId]) {
        porVenda[docId] = {
          docId:        docId,
          contaAzul:    contaAzul,
          numeroVenda:  numeroVenda,
          estado:       String(linha[IDX_ESTADO]  ?? ""),
          cliente:      String(linha[IDX_CLIENTE] ?? ""),
          boletos: []
        };
      }

      const vencimento = linha[IDX_VENCIMENTO];
      porVenda[docId].boletos.push({
        valorOriginal:  typeof linha[IDX_VALOR_ORI] === "number" ? linha[IDX_VALOR_ORI] : 0,
        juros:          typeof linha[IDX_JUROS]     === "number" ? linha[IDX_JUROS]     : 0,
        dataVencimento: vencimento instanceof Date
          ? Utilities.formatDate(vencimento, "America/Sao_Paulo", "yyyy-MM-dd")
          : String(vencimento ?? ""),
        status:         String(linha[IDX_STATUS]     ?? ""),
        valorPago:          typeof linha[IDX_VALOR_PAGO] === "number" ? linha[IDX_VALOR_PAGO] : 0,
        valorEmAberto:      typeof linha[IDX_EM_ABERTO]  === "number" ? linha[IDX_EM_ABERTO]  : 0,
        diasAtraso:         typeof linha[IDX_DIAS_ATR]   === "number" ? linha[IDX_DIAS_ATR]   : 0,
        comissaoBloqueada:  typeof linha[IDX_COM_BLOQ]   === "number" ? linha[IDX_COM_BLOQ]   : 0,
      });
    }

    Logger.log("🔑 Vendas únicas: " + Object.keys(porVenda).length);

    // Monta os documentos Firestore
    const allWrites = [];
    for (const docId in porVenda) {
      const doc = porVenda[docId];

      // Calcula statusGeral
      const statuses = doc.boletos.map(b => b.status);
      let statusGeral;
      if (statuses.every(s => s === "RECEBIDO")) {
        statusGeral = "RECEBIDO";
      } else if (statuses.some(s => s === "ATRASADO")) {
        statusGeral = "ATRASADO";
      } else if (statuses.some(s => s === "PERDIDO")) {
        statusGeral = "PERDIDO";
      } else {
        statusGeral = "EM_ABERTO";
      }

      // Soma comissaoBloqueada dos boletos ATRASADOS
      const comissaoBloqueadaTotal = doc.boletos
        .filter(b => b.status === "ATRASADO")
        .reduce((s, b) => s + b.comissaoBloqueada, 0);

      const boletosFirestore = doc.boletos.map(b => ({
        mapValue: {
          fields: {
            valorOriginal:     { doubleValue: b.valorOriginal },
            juros:             { doubleValue: b.juros },
            dataVencimento:    { stringValue: b.dataVencimento },
            status:            { stringValue: b.status },
            valorPago:         { doubleValue: b.valorPago },
            valorEmAberto:     { doubleValue: b.valorEmAberto },
            diasAtraso:        { doubleValue: b.diasAtraso },
            comissaoBloqueada: { doubleValue: b.comissaoBloqueada },
          }
        }
      }));

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + FIREBASE_COLLECTION_FIN + "/" + encodeURIComponent(docId),
          fields: {
            docId:              { stringValue: docId },
            contaAzul:          { stringValue: doc.contaAzul },
            numeroVenda:        { stringValue: doc.numeroVenda },
            estado:             { stringValue: doc.estado },
            cliente:            { stringValue: doc.cliente },
            statusGeral:        { stringValue: statusGeral },
            comissaoBloqueada:  { doubleValue: comissaoBloqueadaTotal },
            boletos:            { arrayValue: { values: boletosFirestore } },
          }
        }
      });
    }

    Logger.log("📝 Documentos a enviar: " + allWrites.length);

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

    Logger.log("✅ Financeiro concluído! Sucesso: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}
