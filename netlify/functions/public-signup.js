const PLAN_VALUE = 27.97;
const PLAN_DESCRIPTION = "Assinatura mensal Plataforma Choque de Gestao";
const FIRST_DUE_DAYS = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const config = getConfig();
  if (config.error) return config.error;

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Dados invalidos." });
  }

  const company = normalizeCompany(payload);
  const validationError = validateCompany(company, payload.aceite);
  if (validationError) {
    return json(400, { ok: false, error: validationError });
  }

  try {
    const existingCompany = await findExistingCompany(config, company);
    const existingSubscription = existingCompany
      ? await selectOne(config, "assinaturas", `empresa_id=eq.${encodeURIComponent(existingCompany.id)}`)
      : null;

    if (existingSubscription?.asaas_subscription_id) {
      return json(409, {
        ok: false,
        error: "Esta empresa ja possui assinatura criada. Abra o pagamento ou fale com o suporte.",
        invoiceUrl: existingSubscription.invoice_url || null
      });
    }

    const customerId = existingCompany?.asaas_customer_id || await createAsaasCustomer(config, {
      ...company,
      id: existingCompany?.id || company.documento
    });

    let empresa = existingCompany;
    if (empresa) {
      if (!empresa.asaas_customer_id) {
        await patchRows(config, "empresas", `id=eq.${empresa.id}`, {
          asaas_customer_id: customerId,
          updated_at: new Date().toISOString()
        });
        empresa = { ...empresa, asaas_customer_id: customerId };
      }
    } else {
      empresa = await createCompany(config, {
        ...company,
        asaas_customer_id: customerId
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

    await insertRows(config, "assinaturas", [{
      empresa_id: empresa.id,
      asaas_subscription_id: subscription.id,
      asaas_customer_id: customerId,
      status: subscription.status || "pendente",
      valor: PLAN_VALUE,
      proximo_vencimento: subscription.nextDueDate || dueDate,
      invoice_url: invoiceUrl,
      updated_at: new Date().toISOString()
    }]);

    await patchRows(config, "empresas", `id=eq.${empresa.id}`, {
      status: "pendente",
      updated_at: new Date().toISOString()
    });

    return json(201, {
      ok: true,
      empresaId: empresa.id,
      customerId,
      subscriptionId: subscription.id,
      invoiceUrl,
      value: PLAN_VALUE,
      dueDate: subscription.nextDueDate || dueDate
    });
  } catch (error) {
    console.error("Erro ao cadastrar adesao publica", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: publicErrorMessage(error, config)
    });
  }
};

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const asaasApiKey = process.env.ASAAS_API_KEY;
  const asaasApiBaseUrl = process.env.ASAAS_API_BASE_URL || "https://sandbox.asaas.com/api/v3";

  if (!supabaseUrl || !serviceRoleKey || !asaasApiKey) {
    return {
      error: json(500, {
        ok: false,
        error: "Configuracao de integracao incompleta."
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

function normalizeCompany(payload) {
  return {
    nome: cleanText(payload.nome),
    responsavel: cleanText(payload.responsavel),
    email: cleanText(payload.email)?.toLowerCase() || null,
    telefone: onlyDigits(payload.telefone),
    documento: onlyDigits(payload.documento),
    status: "pendente",
    updated_at: new Date().toISOString()
  };
}

function validateCompany(company, aceite) {
  if (!company.nome) return "Informe o nome da empresa.";
  if (!company.responsavel) return "Informe o nome do responsavel.";
  if (!company.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) {
    return "Informe um e-mail valido.";
  }
  if (!company.telefone || company.telefone.length < 10) {
    return "Informe um WhatsApp valido.";
  }
  if (!company.documento || ![11, 14].includes(company.documento.length)) {
    return "Informe CPF ou CNPJ com 11 ou 14 digitos.";
  }
  if (!isValidCpfCnpj(company.documento)) {
    return "CPF ou CNPJ invalido. Confira os numeros digitados.";
  }
  if (aceite !== true) return "Aceite os termos para continuar.";
  return null;
}

async function findExistingCompany(config, company) {
  const documentMatch = company.documento
    ? await selectOne(config, "empresas", `documento=eq.${encodeURIComponent(company.documento)}`)
    : null;
  if (documentMatch) return documentMatch;

  return selectOne(config, "empresas", `email=eq.${encodeURIComponent(company.email)}`);
}

async function createCompany(config, company) {
  const inserted = await insertRows(config, "empresas", [company], "return=representation");
  return inserted[0] || null;
}

async function createAsaasCustomer(config, empresa) {
  const customer = await asaasRequest(config, "customers", {
    method: "POST",
    body: JSON.stringify(removeEmpty({
      name: empresa.nome,
      email: empresa.email,
      mobilePhone: empresa.telefone,
      cpfCnpj: empresa.documento,
      externalReference: empresa.id || empresa.documento,
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
    console.warn("Nao foi possivel consultar a cobranca inicial", {
      message: error.message
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
      "User-Agent": "ChoqueGestaoPublicSignup/1.0"
    },
    body: options.body
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(`Asaas ${response.status}: ${JSON.stringify(body)}`);
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function selectOne(config, table, query) {
  const rows = await supabaseRequest(config, `${table}?select=*&${query}&limit=1`);
  return rows[0] || null;
}

async function insertRows(config, table, rows, prefer = "return=minimal") {
  return supabaseRequest(config, table, {
    method: "POST",
    headers: { Prefer: prefer },
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

  if (response.status === 204) return [];

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function onlyDigits(value) {
  const text = String(value || "").replace(/\D/g, "");
  return text || null;
}

function isValidCpfCnpj(value) {
  const digits = onlyDigits(value);
  if (!digits) return false;
  if (digits.length === 11) return isValidCpf(digits);
  if (digits.length === 14) return isValidCnpj(digits);
  return false;
}

function isValidCpf(cpf) {
  if (/^(\d)\1+$/.test(cpf)) return false;

  const digit = (base, factor) => {
    let total = 0;
    for (let index = 0; index < base.length; index += 1) {
      total += Number(base[index]) * (factor - index);
    }
    const rest = (total * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  const first = digit(cpf.slice(0, 9), 10);
  const second = digit(cpf.slice(0, 9) + first, 11);
  return cpf.endsWith(`${first}${second}`);
}

function isValidCnpj(cnpj) {
  if (/^(\d)\1+$/.test(cnpj)) return false;

  const digit = (base) => {
    const weights = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const total = base.split("").reduce((sum, number, index) => sum + Number(number) * weights[index], 0);
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const first = digit(cnpj.slice(0, 12));
  const second = digit(cnpj.slice(0, 12) + first);
  return cnpj.endsWith(`${first}${second}`);
}

function publicErrorMessage(error, config) {
  const serialized = JSON.stringify(error.body || {});
  if (error.statusCode === 400 && /CPF\/CNPJ|cpfCnpj|invalid_object/i.test(serialized)) {
    if ((config.asaasApiBaseUrl || "").includes("sandbox")) {
      return "O Asaas Sandbox recusou este CPF/CNPJ. Para teste, use um CPF/CNPJ aceito pelo ambiente sandbox.";
    }

    return "O Asaas recusou este CPF/CNPJ. Confira o documento informado.";
  }

  if (/duplicate key|23505/i.test(error.message)) {
    return "Ja existe cadastro para este CPF/CNPJ ou e-mail.";
  }

  return "Nao foi possivel concluir o cadastro agora. Confira os dados e tente novamente.";
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
