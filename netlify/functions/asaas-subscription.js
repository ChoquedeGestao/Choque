const PLAN_VALUE = 27.97;
const PLAN_DESCRIPTION = "Assinatura mensal Plataforma Choque de Gestao";
const FIRST_DUE_DAYS = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const authError = validateAdmin(event);
  if (authError) return authError;

  const config = getConfig();
  if (config.error) return config.error;

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "JSON invalido." });
  }

  const companyId = cleanText(payload.empresa_id);
  if (!companyId) {
    return json(400, { ok: false, error: "Empresa nao informada." });
  }

  try {
    const empresa = await selectOne(config, "empresas", `id=eq.${encodeURIComponent(companyId)}`);
    if (!empresa) {
      return json(404, { ok: false, error: "Empresa nao encontrada." });
    }

    const existingSubscription = await selectOne(
      config,
      "assinaturas",
      `empresa_id=eq.${encodeURIComponent(companyId)}`
    );

    if (existingSubscription?.asaas_subscription_id) {
      return json(409, {
        ok: false,
        error: "Esta empresa ja possui assinatura criada."
      });
    }

    const customerId = empresa.asaas_customer_id || await createAsaasCustomer(config, empresa);
    if (!empresa.asaas_customer_id) {
      await patchRows(config, "empresas", `id=eq.${empresa.id}`, {
        asaas_customer_id: customerId,
        updated_at: new Date().toISOString()
      });
    }

    const dueDate = addDays(new Date(), FIRST_DUE_DAYS);
    const subscription = await createAsaasSubscription(config, {
      customerId,
      empresa,
      dueDate
    });
    const firstPayment = await getFirstSubscriptionPayment(config, subscription.id);
    const invoiceUrl = getPaymentLink(firstPayment) || getPaymentLink(subscription);

    const subscriptionPayload = {
      empresa_id: empresa.id,
      asaas_subscription_id: subscription.id,
      asaas_customer_id: customerId,
      status: subscription.status || "pendente",
      valor: PLAN_VALUE,
      proximo_vencimento: subscription.nextDueDate || dueDate,
      invoice_url: invoiceUrl,
      updated_at: new Date().toISOString()
    };

    if (existingSubscription) {
      await patchRows(config, "assinaturas", `id=eq.${existingSubscription.id}`, subscriptionPayload);
    } else {
      await insertRows(config, "assinaturas", [subscriptionPayload]);
    }

    await patchRows(config, "empresas", `id=eq.${empresa.id}`, {
      status: "pendente",
      updated_at: new Date().toISOString()
    });

    return json(201, {
      ok: true,
      customerId,
      subscriptionId: subscription.id,
      invoiceUrl,
      value: PLAN_VALUE,
      dueDate: subscription.nextDueDate || dueDate,
      paymentId: firstPayment?.id || null
    });
  } catch (error) {
    console.error("Erro ao criar assinatura Asaas", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Erro ao criar assinatura no Asaas."
    });
  }
};

function validateAdmin(event) {
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

  return null;
}

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const asaasApiKey = process.env.ASAAS_API_KEY;
  const asaasApiBaseUrl = process.env.ASAAS_API_BASE_URL || "https://sandbox.asaas.com/api/v3";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      error: json(500, {
        ok: false,
        error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nao configurado."
      })
    };
  }

  if (!asaasApiKey) {
    return {
      error: json(500, {
        ok: false,
        error: "ASAAS_API_KEY nao configurado no Netlify."
      })
    };
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    asaasApiKey,
    asaasApiBaseUrl
  };
}

async function createAsaasCustomer(config, empresa) {
  const customer = await asaasRequest(config, "customers", {
    method: "POST",
    body: JSON.stringify(removeEmpty({
      name: empresa.nome,
      email: empresa.email,
      mobilePhone: empresa.telefone,
      cpfCnpj: empresa.documento,
      externalReference: empresa.id,
      notificationDisabled: false
    }))
  });

  if (!customer.id) {
    throw new Error("Asaas nao retornou ID do cliente.");
  }

  return customer.id;
}

async function createAsaasSubscription(config, data) {
  return asaasRequest(config, "subscriptions", {
    method: "POST",
    body: JSON.stringify(removeEmpty({
      customer: data.customerId,
      billingType: "UNDEFINED",
      cycle: "MONTHLY",
      value: PLAN_VALUE,
      nextDueDate: data.dueDate,
      description: PLAN_DESCRIPTION,
      externalReference: data.empresa.id
    }))
  });
}

async function getFirstSubscriptionPayment(config, subscriptionId) {
  if (!subscriptionId) return null;

  try {
    const response = await asaasRequest(
      config,
      `payments?subscription=${encodeURIComponent(subscriptionId)}&limit=1`
    );

    return response.data?.[0] || null;
  } catch (error) {
    console.warn("Nao foi possivel consultar a primeira cobranca da assinatura", {
      message: error.message,
      subscriptionId
    });
    return null;
  }
}

async function asaasRequest(config, path, options = {}) {
  const response = await fetch(`${config.asaasApiBaseUrl.replace(/\/$/, "")}/${path}`, {
    method: options.method || "GET",
    headers: {
      access_token: config.asaasApiKey,
      "Content-Type": "application/json",
      "User-Agent": "ChoqueGestaoAdmin/1.0"
    },
    body: options.body
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Asaas ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function selectOne(config, table, query) {
  const rows = await supabaseRequest(config, `${table}?select=*&${query}&limit=1`);
  return rows[0] || null;
}

async function insertRows(config, table, rows) {
  return supabaseRequest(config, table, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows)
  });
}

async function patchRows(config, table, filter, data) {
  return supabaseRequest(config, `${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(data)
  });
}

async function supabaseRequest(config, path, options = {}) {
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    body: options.body
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return [];
  }

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function getBearerToken(header) {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function addDays(date, days) {
  const nextDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate.toISOString().slice(0, 10);
}

function removeEmpty(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function getPaymentLink(data = {}) {
  return data.invoiceUrl || data.bankSlipUrl || data.paymentLink || data.checkoutUrl || null;
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
