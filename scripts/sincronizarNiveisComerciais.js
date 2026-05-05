// ============================================================
// SINCRONIZAR TABELA DE NÍVEIS COMERCIAL → Firestore
// Coleção: "niveisComerciais"
// Rodar apenas uma vez (ou quando a tabela mudar)
// ============================================================

function sincronizarNiveisComerciais() {
  var SHEET_NIVEIS             = "Tabela de Níveis Comercial";
  var FIREBASE_COLLECTION_NIV  = "niveisComerciais";

  // Índices das colunas (começa em 0)
  var NIV_NIVEL    = 0; // A — Nome do nível
  var NIV_COM_MIN  = 1; // B — Comissão Mínima (%)
  var NIV_INAD_MAX = 2; // C — Inadimplência Máxima (%)
  var NIV_CLI_ATIV = 3; // D — Clientes Ativos Mínimos (qtd)
  var NIV_FAT_CLI  = 4; // E — Faturamento por Cliente Mínimo (R$)
  // F foi removida (era Prêmio Pontual)
  var NIV_ADICIONAL = 5; // F (era G) — Adicional de comissão para se manter no nível (%)

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

    var sheet = ss.getSheetByName(SHEET_NIVEIS);
    if (!sheet) {
      Logger.log("❌ Aba '" + SHEET_NIVEIS + "' não encontrada!");
      return;
    }

    var dados = sheet.getDataRange().getValues();
    Logger.log("📊 Níveis encontrados: " + (dados.length - 1));

    var allWrites = [];

    for (var i = 1; i < dados.length; i++) {
      var linha = dados[i];
      var nivel = String(linha[NIV_NIVEL] ?? "").trim();
      if (!nivel) continue;

      function numOuZero(val) {
        return typeof val === "number" ? val : Number(String(val).replace(",", ".")) || 0;
      }

      var docId = nivel.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "_");

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/"
                + FIREBASE_COLLECTION_NIV + "/" + docId,
          fields: {
            nivel:             { stringValue: nivel },
            ordem:             { integerValue: String(i) },
            comissaoMinima:    { doubleValue: numOuZero(linha[NIV_COM_MIN])   },
            inadimplenciaMax:  { doubleValue: numOuZero(linha[NIV_INAD_MAX])  },
            clientesAtivosMin: { integerValue: String(Math.round(numOuZero(linha[NIV_CLI_ATIV]))) },
            fatPorClienteMin:  { doubleValue: numOuZero(linha[NIV_FAT_CLI])   },
            adicionalComissao: { doubleValue: numOuZero(linha[NIV_ADICIONAL]) },
          }
        }
      });
    }

    Logger.log("📝 Níveis a enviar: " + allWrites.length);

    var batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                 + "/databases/(default)/documents:batchWrite";

    var token = ScriptApp.getOAuthToken();
    var resp = UrlFetchApp.fetch(batchUrl, {
      method: "POST",
      contentType: "application/json",
      headers: { "Authorization": "Bearer " + token },
      payload: JSON.stringify({ writes: allWrites }),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() === 200) {
      Logger.log("✅ Tabela de Níveis sincronizada! " + allWrites.length + " níveis.");
    } else {
      Logger.log("❌ Erro HTTP " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
    }

  } finally {
    lock.releaseLock();
  }
}
