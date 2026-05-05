// ============================================================
// SINCRONIZAR RELATÓRIO DE VISITAS → Firestore
// Coleção: "relatorioVisitas"
// Deduplicação: mesmo CNPJ → todos os registros mantidos,
//               mas nome da empresa padronizado para o último.
// ============================================================

function normalizarVis(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function formatarDataHoraVis(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, "America/Sao_Paulo", "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(val || "").trim();
}

function formatarDataDDMMYYYY(val) {
  if (!val || val === "") return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, "America/Sao_Paulo", "dd/MM/yyyy");
  }
  var s = String(val).trim();
  var isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[3] + "/" + isoMatch[2] + "/" + isoMatch[1];
  return s;
}

function extrairCnpjVis(linha, colR, colS) {
  var raw = linha[colS] || linha[colR];
  return String(typeof raw === "number" ? Math.round(raw) : raw || "").replace(/\D/g, "");
}

function sincronizarRelatorioVisitas() {
  // ── constantes locais (evita conflito com outros arquivos) ──
  var SHEET_VISITAS = "Relatório de Visita";
  var COL_CARIMBO      = 0;
  var COL_DATA_HORA    = 1;
  var COL_VENDEDOR     = 2;
  var COL_EMPRESA      = 3;
  var COL_LOCAL        = 4;
  var COL_CONTATO      = 5;
  var COL_TIPO_CLI     = 6;
  var COL_OBJETIVO     = 7;
  var COL_PEDIDO       = 8;
  var COL_SATISFACAO   = 9;
  var COL_PRODUTOS     = 10;
  var COL_PROXPASSOS   = 11;
  var COL_ANEXO        = 12;
  var COL_AGENDADA     = 13;
  var COL_ANOTACOES    = 14;
  var COL_QTD_VISITAS  = 15;
  var COL_TELEFONE     = 16;
  var COL_CNPJ_R           = 17;
  var COL_CNPJ_S           = 18;
  var COL_ESTADO           = 19;
  // U = 20 (reservado)
  var COL_VENDEDOR_RESP    = 21; // coluna V — Vendedor Responsável

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log("⚠️ Outra execução já está em andamento. Abortando.");
    return;
  }

  try {
    var ss;
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
    } catch(e) {
      Logger.log("❌ Erro ao abrir planilha: " + e);
      return;
    }

    var sheet = ss.getSheetByName(SHEET_VISITAS);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_VISITAS + "' não encontrada!");
      return;
    }

    var dados = sheet.getDataRange().getValues();
    Logger.log("📊 Linhas no Relatório de Visitas: " + (dados.length - 1));

    // ── PASSO 1: último nome de empresa por CNPJ ─────────
    var ultimaEmpresaPorCnpj = {};
    for (var i = 1; i < dados.length; i++) {
      var linha    = dados[i];
      var carimbo  = linha[COL_CARIMBO];
      var vendedor = String(linha[COL_VENDEDOR] || "").trim();
      if (!carimbo || !vendedor) continue;

      var cnpj    = extrairCnpjVis(linha, COL_CNPJ_R, COL_CNPJ_S);
      var empresa = String(linha[COL_EMPRESA] || "").trim();
      if (cnpj && empresa) {
        ultimaEmpresaPorCnpj[cnpj] = empresa;
      }
    }

    // ── PASSO 2: montar writes para TODAS as linhas válidas ─
    var allWrites = [];

    for (var i = 1; i < dados.length; i++) {
      var linha    = dados[i];
      var carimbo  = linha[COL_CARIMBO];
      var vendedor = String(linha[COL_VENDEDOR] || "").trim();
      if (!carimbo || !vendedor) continue;

      var cnpj            = extrairCnpjVis(linha, COL_CNPJ_R, COL_CNPJ_S);
      var empresaOriginal = String(linha[COL_EMPRESA] || "").trim();
      var empresa         = (cnpj && ultimaEmpresaPorCnpj[cnpj]) || empresaOriginal;

      var carimboStr = carimbo instanceof Date
        ? Utilities.formatDate(carimbo, "America/Sao_Paulo", "yyyyMMdd_HHmmss")
        : String(carimbo).replace(/[^0-9]/g, "").slice(0, 14);

      var docId = normalizarVis(vendedor)
        + "_" + normalizarVis(empresa || "sem_empresa")
        + "_" + carimboStr;

      var satisfacao = linha[COL_SATISFACAO];
      var qtdVisitas = linha[COL_QTD_VISITAS];

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + "relatorioVisitas/" + encodeURIComponent(docId),
          fields: {
            docId:             { stringValue: docId },
            carimbo:           { stringValue: formatarDataHoraVis(carimbo) },
            dataHoraVisita:    { stringValue: formatarDataHoraVis(linha[COL_DATA_HORA]) },
            estado:            { stringValue: String(linha[COL_ESTADO] || "").trim() },
            vendedor:          { stringValue: vendedor },
            empresa:           { stringValue: empresa },
            local:             { stringValue: String(linha[COL_LOCAL]       || "") },
            contato:           { stringValue: String(linha[COL_CONTATO]     || "") },
            tipoCliente:       { stringValue: String(linha[COL_TIPO_CLI]    || "") },
            objetivo:          { stringValue: String(linha[COL_OBJETIVO]    || "") },
            geracaoPedido:     { stringValue: String(linha[COL_PEDIDO]      || "") },
            satisfacao:        typeof satisfacao === "number"
                                 ? { doubleValue: satisfacao }
                                 : { stringValue: String(satisfacao || "") },
            produtosAbordados: { stringValue: String(linha[COL_PRODUTOS]    || "") },
            proximosPassos:    { stringValue: String(linha[COL_PROXPASSOS]  || "") },
            anexo:             { stringValue: String(linha[COL_ANEXO]       || "") },
            agendada:          { stringValue: String(linha[COL_AGENDADA]    || "") },
            anotacoes:         { stringValue: String(linha[COL_ANOTACOES]   || "") },
            qtdVisitas:        typeof qtdVisitas === "number"
                                 ? { doubleValue: qtdVisitas }
                                 : { stringValue: String(qtdVisitas || "") },
            telefone:          { stringValue: String(linha[COL_TELEFONE]    || "") },
            cnpj:              { stringValue: cnpj },
            vendedorResponsavel: { stringValue: String(linha[COL_VENDEDOR_RESP] || "").trim() },
          }
        }
      });
    }

    Logger.log("📝 Registros a enviar: " + allWrites.length
      + " | CNPJs padronizados: " + Object.keys(ultimaEmpresaPorCnpj).length);

    // ── ENVIO EM LOTES ────────────────────────────────────
    var batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                 + "/databases/(default)/documents:batchWrite";
    var sucesso = 0, erro = 0;
    var totalLotes = Math.ceil(allWrites.length / BATCH_SIZE);

    for (var i = 0; i < allWrites.length; i += BATCH_SIZE) {
      var lote    = allWrites.slice(i, i + BATCH_SIZE);
      var numLote = Math.floor(i / BATCH_SIZE) + 1;
      var enviado = false;

      for (var tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
        var token = ScriptApp.getOAuthToken();
        try {
          var resp = UrlFetchApp.fetch(batchUrl, {
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

    Logger.log("✅ Relatório de Visitas concluído! Sucesso: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}
