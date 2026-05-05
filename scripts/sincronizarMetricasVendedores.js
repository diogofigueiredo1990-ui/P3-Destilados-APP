// ============================================================
// SINCRONIZAR MÉTRICAS DOS VENDEDORES → Firestore
// Coleção: "metricasVendedores"
// Rode diariamente via trigger (ex: às 6h)
// ============================================================

// ── ABA ──────────────────────────────────────────────────────
var MV_SHEET_PEDIDOS = "Histórico de Pedidos";

// ── ÍNDICES — Histórico de Pedidos (0-based) ─────────────────
var MV_COL_ESTADO      = 0;  // A — Estado / contaAzul (GO, MG, SP…)
var MV_COL_DATA_VENDA  = 4;  // E — Data da venda (Date)
var MV_COL_VENDEDOR    = 5;  // F — Vendedor da venda
var MV_COL_CNPJ        = 3;  // D — CNPJ do cliente
var MV_COL_FATURAMENTO = 20; // U — Faturamento R$
var MV_COL_COMISSAO    = 22; // W — Comissão R$
var MV_COL_CHAVE       = 17; // R — Chave (ex: GO_7_PRODUTO)

// ─────────────────────────────────────────────────────────────

function diasUteisAtrasGAS(n) {
  var d = new Date();
  var count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return Utilities.formatDate(d, "America/Sao_Paulo", "yyyy-MM-dd");
}

function normalizarCnpjGAS(val) {
  return String(typeof val === "number" ? Math.round(val) : val || "").replace(/\D/g, "");
}

function extrairNumeroVendaGAS(chave) {
  var partes = String(chave || "").split("_");
  return partes.length >= 2 ? partes[1] : null;
}

// Consulta Firestore financeiro em lotes — mesma lógica do app React
// Retorna mapa: finId → statusGeral ("ATRASADO", "RECEBIDO", etc.)
function buscarStatusFinanceiro(finIds, projectId, token) {
  var mapa = {};
  if (!finIds.length) return mapa;

  var url = "https://firestore.googleapis.com/v1/projects/" + projectId
          + "/databases/(default)/documents:runQuery";

  var batchSize = 30;
  for (var i = 0; i < finIds.length; i += batchSize) {
    var lote = finIds.slice(i, i + batchSize);

    var body = {
      structuredQuery: {
        from: [{ collectionId: "financeiro" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "docId" },
            op: "IN",
            value: { arrayValue: { values: lote.map(function(id) { return { stringValue: id }; }) } }
          }
        },
        select: { fields: [{ fieldPath: "docId" }, { fieldPath: "statusGeral" }] }
      }
    };

    var resp = UrlFetchApp.fetch(url, {
      method: "POST",
      contentType: "application/json",
      headers: { "Authorization": "Bearer " + token },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() === 200) {
      var results = JSON.parse(resp.getContentText());
      results.forEach(function(r) {
        if (r.document && r.document.fields) {
          var docId  = (r.document.fields.docId  || {}).stringValue;
          var status = (r.document.fields.statusGeral || {}).stringValue || "EM_ABERTO";
          if (docId) mapa[docId] = status;
        }
      });
    } else {
      Logger.log("⚠️ Erro ao buscar financeiro lote " + (i / batchSize + 1) + ": " + resp.getResponseCode());
    }
    Utilities.sleep(200);
  }
  return mapa;
}

function sincronizarMetricasVendedores() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("⚠️ Outra execução já está em andamento. Abortando.");
    return;
  }

  try {
    var ss;
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID_FB);
    } catch (e) {
      Logger.log("❌ Erro ao abrir planilha: " + e);
      return;
    }

    var sheet = ss.getSheetByName(MV_SHEET_PEDIDOS);
    if (!sheet) {
      Logger.log("❌ Aba '" + MV_SHEET_PEDIDOS + "' não encontrada!");
      return;
    }

    var dados      = sheet.getDataRange().getValues();
    var dataInicio = diasUteisAtrasGAS(24);
    var dataHoje   = Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd");

    Logger.log("📊 Período: " + dataInicio + " → " + dataHoje);
    Logger.log("📊 Total de linhas: " + (dados.length - 1));

    // ── 1ª passagem: filtra linhas do período e coleta finIds ─
    var linhasFiltradas = [];
    var finIdsUnicos    = {};

    for (var i = 1; i < dados.length; i++) {
      var linha    = dados[i];
      var vendedor = String(linha[MV_COL_VENDEDOR] || "").trim();
      if (!vendedor) continue;

      var dataVenda = linha[MV_COL_DATA_VENDA];
      var dataStr   = dataVenda instanceof Date
        ? Utilities.formatDate(dataVenda, "America/Sao_Paulo", "yyyy-MM-dd")
        : String(dataVenda || "").slice(0, 10);
      if (dataStr < dataInicio || dataStr > dataHoje) continue;

      var estado = String(linha[MV_COL_ESTADO] || "").trim();
      var nv     = extrairNumeroVendaGAS(linha[MV_COL_CHAVE]);
      var finId  = (estado && nv) ? estado + "_" + nv : null;
      if (finId) finIdsUnicos[finId] = true;

      linhasFiltradas.push({
        vendedor: vendedor,
        fat:      typeof linha[MV_COL_FATURAMENTO] === "number" ? linha[MV_COL_FATURAMENTO] : 0,
        com:      typeof linha[MV_COL_COMISSAO]    === "number" ? linha[MV_COL_COMISSAO]    : 0,
        cnpj:     normalizarCnpjGAS(linha[MV_COL_CNPJ]),
        finId:    finId
      });
    }

    Logger.log("📊 Pedidos no período: " + linhasFiltradas.length);
    Logger.log("📊 finIds únicos: " + Object.keys(finIdsUnicos).length);

    // ── Busca status financeiro no Firestore (mesma fonte do app) ─
    var token         = ScriptApp.getOAuthToken();
    var statusFinMap  = buscarStatusFinanceiro(Object.keys(finIdsUnicos), FIREBASE_PROJECT_ID, token);
    Logger.log("📊 Registros financeiros encontrados: " + Object.keys(statusFinMap).length);

    // ── 2ª passagem: agrupa por vendedor ──────────────────────
    var vendedores = {};

    linhasFiltradas.forEach(function(p) {
      var v = vendedores[p.vendedor];
      if (!v) {
        v = { fat: 0, com: 0, cnpjs: {}, fatBloq: 0 };
        vendedores[p.vendedor] = v;
      }
      v.fat += p.fat;
      v.com += p.com;
      if (p.cnpj) v.cnpjs[p.cnpj] = true;
      var status = p.finId ? (statusFinMap[p.finId] || "EM_ABERTO") : "EM_ABERTO";
      if (status === "ATRASADO") v.fatBloq += p.fat;
    });

    Logger.log("📊 Vendedores encontrados: " + Object.keys(vendedores).length);

    if (!Object.keys(vendedores).length) {
      Logger.log("⚠️ Nenhuma métrica calculada.");
      return;
    }

    // ── Monta writes ──────────────────────────────────────────
    var allWrites = [];

    for (var nome in vendedores) {
      var v                    = vendedores[nome];
      var clientesAtivos       = Object.keys(v.cnpjs).length;
      var fatPorCliente        = clientesAtivos > 0 ? v.fat / clientesAtivos : 0;
      var comissaoPercent      = v.fat > 0 ? (v.com  / v.fat) * 100 : 0;
      var inadimplenciaPercent = v.fat > 0 ? (v.fatBloq / v.fat) * 100 : 0;

      var docId = nome.toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

      allWrites.push({
        update: {
          name: "projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/metricasVendedores/" + docId,
          fields: {
            vendedor:             { stringValue: nome                    },
            totalFat:             { doubleValue: v.fat                   },
            comissaoPercent:      { doubleValue: comissaoPercent         },
            inadimplenciaPercent: { doubleValue: inadimplenciaPercent    },
            clientesAtivos:       { integerValue: String(clientesAtivos) },
            fatPorCliente:        { doubleValue: fatPorCliente           },
            dataInicio:           { stringValue: dataInicio              },
            dataAtualizacao:      { stringValue: dataHoje                },
          }
        }
      });
    }

    // ── Envia em lotes ────────────────────────────────────────
    var batchUrl = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID
                 + "/databases/(default)/documents:batchWrite";
    var sucesso = 0, erro = 0;

    for (var i = 0; i < allWrites.length; i += BATCH_SIZE) {
      var lote = allWrites.slice(i, i + BATCH_SIZE);
      token    = ScriptApp.getOAuthToken();
      var resp = UrlFetchApp.fetch(batchUrl, {
        method:             "POST",
        contentType:        "application/json",
        headers:            { "Authorization": "Bearer " + token },
        payload:            JSON.stringify({ writes: lote }),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        sucesso += lote.length;
        Logger.log("✅ Lote " + (Math.floor(i / BATCH_SIZE) + 1) + " — " + sucesso + "/" + allWrites.length);
      } else {
        erro += lote.length;
        Logger.log("❌ Erro HTTP " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 200));
      }
      Utilities.sleep(300);
    }

    Logger.log("✅ Concluído! Sucesso: " + sucesso + " | Erros: " + erro);

  } finally {
    lock.releaseLock();
  }
}
