const allowedEvents = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_DELETED"
]);

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      service: "asaas-webhook",
      environment: process.env.ASAAS_ENVIRONMENT || "sandbox"
    });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expectedToken) {
    return json(500, { ok: false, error: "ASAAS_WEBHOOK_TOKEN nao configurado." });
  }

  const receivedToken = event.headers["asaas-access-token"] || event.headers["Asaas-Access-Token"];
  if (receivedToken !== expectedToken) {
    return json(401, { ok: false, error: "Token do webhook invalido." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "JSON invalido." });
  }

  const eventName = payload.event || "";
  if (!allowedEvents.has(eventName)) {
    return json(200, {
      ok: true,
      ignored: true,
      event: eventName || "EVENTO_NAO_INFORMADO"
    });
  }

  const summary = {
    event: eventName,
    paymentId: getObjectId(payload.payment),
    subscriptionId: getObjectId(payload.subscription) || getObjectId(payload.payment?.subscription),
    customerId: getObjectId(payload.customer) || getObjectId(payload.payment?.customer) || getObjectId(payload.subscription?.customer)
  };

  console.log("Asaas webhook recebido", summary);

  try {
    await persistAsaasEvent(eventName, payload, summary);
  } catch (error) {
    console.error("Erro ao gravar webhook no Supabase", {
      message: error.message,
      event: eventName,
      paymentId: summary.paymentId,
      subscriptionId: summary.subscriptionId,
      customerId: summary.customerId
    });

    return json(500, {
      ok: false,
      error: "Erro ao gravar evento no banco de dados."
    });
  }

  return json(200, {
    ok: true,
    event: eventName
  });
};

async function persistAsaasEvent(eventName, payload, summary) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nao configurado.");
  }

  const payment = payload.payment || {};
  const subscription = payload.subscription || {};
  const customerId = summary.customerId || getObjectId(payment.customer) || getObjectId(subscription.customer) || null;
  const subscriptionId = summary.subscriptionId || subscription.id || null;
  const paymentId = summary.paymentId || null;

  const empresa = customerId
    ? await upsertEmpresa(supabaseUrl, serviceRoleKey, payload, customerId)
    : null;

  const assinatura = subscriptionId
    ? await upsertAssinatura(supabaseUrl, serviceRoleKey, {
        empresaId: empresa?.id || null,
        customerId,
        subscriptionId,
        subscription,
        payment
      })
    : null;

  await insertWebhookLog(supabaseUrl, serviceRoleKey, {
    eventName,
    paymentId,
    subscriptionId,
    customerId,
    payload
  });

  if (paymentId) {
    await upsertPagamento(supabaseUrl, serviceRoleKey, {
      empresaId: empresa?.id || null,
      assinaturaId: assinatura?.id || null,
      eventName,
      payment,
      paymentId,
      customerId,
      subscriptionId,
      payload
    });
  }
}

async function upsertEmpresa(supabaseUrl, serviceRoleKey, payload, customerId) {
  const customer = payload.customer || {};
  const payment = payload.payment || {};
  const subscription = payload.subscription || {};
  const existing = await selectOne(supabaseUrl, serviceRoleKey, "empresas", `asaas_customer_id=eq.${encodeURIComponent(customerId)}`);

  const data = {
    nome: customer.name || payment.customerName || subscription.customerName || `Cliente Asaas ${customerId}`,
    email: customer.email || null,
    telefone: customer.mobilePhone || customer.phone || null,
    documento: customer.cpfCnpj || null,
    asaas_customer_id: customerId,
    status: statusFromEvent(payload.event, payment.status || subscription.status),
    updated_at: new Date().toISOString()
  };

  if (!existing) {
    const inserted = await insertRows(supabaseUrl, serviceRoleKey, "empresas", [data], "representation");
    return inserted[0] || null;
  }

  const updated = await patchRows(supabaseUrl, serviceRoleKey, "empresas", `id=eq.${existing.id}`, data, "representation");
  return updated[0] || existing;
}

async function upsertAssinatura(supabaseUrl, serviceRoleKey, data) {
  const empresaId = data.empresaId || await findEmpresaIdByCustomer(supabaseUrl, serviceRoleKey, data.customerId);
  const existing = await selectOne(
    supabaseUrl,
    serviceRoleKey,
    "assinaturas",
    `asaas_subscription_id=eq.${encodeURIComponent(data.subscriptionId)}`
  );

  const payload = {
    empresa_id: empresaId || existing?.empresa_id || null,
    asaas_subscription_id: data.subscriptionId,
    asaas_customer_id: data.customerId || existing?.asaas_customer_id || null,
    status: data.subscription.status || statusFromPayment(data.payment.status),
    valor: toNumber(data.subscription.value || data.payment.value),
    proximo_vencimento: data.subscription.nextDueDate || data.payment.dueDate || null,
    invoice_url: getPaymentLink(data.subscription) || getPaymentLink(data.payment) || existing?.invoice_url || null,
    updated_at: new Date().toISOString()
  };

  if (!existing) {
    const inserted = await insertRows(supabaseUrl, serviceRoleKey, "assinaturas", [payload], "representation");
    return inserted[0] || null;
  }

  const updated = await patchRows(supabaseUrl, serviceRoleKey, "assinaturas", `id=eq.${existing.id}`, payload, "representation");
  return updated[0] || existing;
}

async function upsertPagamento(supabaseUrl, serviceRoleKey, data) {
  const empresaId = data.empresaId || await findEmpresaIdByCustomer(supabaseUrl, serviceRoleKey, data.customerId);
  const payload = {
    empresa_id: empresaId,
    assinatura_id: data.assinaturaId,
    asaas_payment_id: data.paymentId,
    asaas_customer_id: data.customerId,
    asaas_subscription_id: data.subscriptionId,
    evento: data.eventName,
    status: data.payment.status || null,
    valor: toNumber(data.payment.value),
    vencimento: data.payment.dueDate || null,
    pagamento_em: data.payment.paymentDate || data.payment.clientPaymentDate || null,
    invoice_url: getPaymentLink(data.payment),
    payload: data.payload
  };

  const existing = await selectOne(
    supabaseUrl,
    serviceRoleKey,
    "pagamentos",
    `asaas_payment_id=eq.${encodeURIComponent(data.paymentId)}`
  );

  if (!existing) {
    await insertRows(supabaseUrl, serviceRoleKey, "pagamentos", [payload]);
    return;
  }

  await patchRows(supabaseUrl, serviceRoleKey, "pagamentos", `id=eq.${existing.id}`, payload);
}

async function findEmpresaIdByCustomer(supabaseUrl, serviceRoleKey, customerId) {
  if (!customerId) return null;
  const empresa = await selectOne(
    supabaseUrl,
    serviceRoleKey,
    "empresas",
    `asaas_customer_id=eq.${encodeURIComponent(customerId)}`
  );
  return empresa?.id || null;
}

async function insertWebhookLog(supabaseUrl, serviceRoleKey, data) {
  await insertRows(supabaseUrl, serviceRoleKey, "webhook_logs", [{
    origem: "asaas",
    evento: data.eventName,
    asaas_payment_id: data.paymentId,
    asaas_subscription_id: data.subscriptionId,
    asaas_customer_id: data.customerId,
    payload: data.payload
  }]);
}

async function selectOne(supabaseUrl, serviceRoleKey, table, query) {
  const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, `${table}?select=*&${query}&limit=1`);
  return rows[0] || null;
}

async function insertRows(supabaseUrl, serviceRoleKey, table, rows, prefer = "return=minimal") {
  return supabaseRequest(supabaseUrl, serviceRoleKey, table, {
    method: "POST",
    headers: { Prefer: prefer },
    body: JSON.stringify(rows)
  });
}

async function patchRows(supabaseUrl, serviceRoleKey, table, filter, data, prefer = "return=minimal") {
  return supabaseRequest(supabaseUrl, serviceRoleKey, `${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: prefer },
    body: JSON.stringify(data)
  });
}

async function supabaseRequest(supabaseUrl, serviceRoleKey, path, options = {}) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
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

function statusFromEvent(eventName, fallback) {
  if (eventName === "PAYMENT_RECEIVED" || eventName === "PAYMENT_CONFIRMED") {
    return "ativo";
  }

  if (eventName === "PAYMENT_OVERDUE") {
    return "inadimplente";
  }

  if (eventName === "PAYMENT_DELETED" || eventName === "SUBSCRIPTION_DELETED") {
    return "cancelado";
  }

  return statusFromPayment(fallback);
}

function statusFromPayment(status) {
  const map = {
    RECEIVED: "ativo",
    CONFIRMED: "ativo",
    OVERDUE: "inadimplente",
    DELETED: "cancelado"
  };

  return map[status] || "pendente";
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPaymentLink(data = {}) {
  return data.invoiceUrl || data.bankSlipUrl || data.paymentLink || data.checkoutUrl || null;
}

function getObjectId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
}
