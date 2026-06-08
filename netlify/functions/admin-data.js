exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const adminToken = process.env.ADMIN_PANEL_TOKEN;
  if (!adminToken) {
    return json(500, {
      ok: false,
      error: "ADMIN_PANEL_TOKEN nao configurado no Netlify."
    });
  }

  const receivedToken = getBearerToken(event.headers.authorization || event.headers.Authorization);
  if (receivedToken !== adminToken) {
    return json(401, {
      ok: false,
      error: "Senha administrativa invalida."
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, {
      ok: false,
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nao configurado."
    });
  }

  try {
    const [empresas, assinaturas, pagamentos, webhookLogs] = await Promise.all([
      supabaseRequest(supabaseUrl, serviceRoleKey, "empresas?select=*&order=updated_at.desc&limit=50"),
      supabaseRequest(supabaseUrl, serviceRoleKey, "assinaturas?select=*&order=updated_at.desc&limit=50"),
      supabaseRequest(supabaseUrl, serviceRoleKey, "pagamentos?select=*&order=created_at.desc&limit=50"),
      supabaseRequest(supabaseUrl, serviceRoleKey, "webhook_logs?select=*&order=created_at.desc&limit=50")
    ]);
    const subscriptionsByCompany = new Map(
      assinaturas.map((assinatura) => [assinatura.empresa_id, assinatura])
    );
    const empresasComAssinatura = empresas.map((empresa) => {
      const assinatura = subscriptionsByCompany.get(empresa.id);
      return {
        ...empresa,
        asaas_subscription_id: assinatura?.asaas_subscription_id || null,
        assinatura_status: assinatura?.status || null,
        assinatura_valor: assinatura?.valor || null,
        assinatura_vencimento: assinatura?.proximo_vencimento || null,
        assinatura_invoice_url: assinatura?.invoice_url || null
      };
    });

    return json(200, {
      ok: true,
      summary: {
        empresas: empresas.length,
        ativas: empresas.filter((empresa) => empresa.status === "ativo").length,
        assinaturas: assinaturas.length,
        pagamentos: pagamentos.length,
        logs: webhookLogs.length
      },
      empresas: empresasComAssinatura,
      assinaturas,
      pagamentos,
      webhook_logs: webhookLogs
    });
  } catch (error) {
    console.error("Erro ao consultar painel administrativo", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Erro ao consultar dados administrativos."
    });
  }
};

async function supabaseRequest(supabaseUrl, serviceRoleKey, path) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  return response.json();
}

function getBearerToken(header) {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
