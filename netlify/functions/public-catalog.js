exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, {
      ok: false,
      error: "Configuracao de banco de dados incompleta."
    });
  }

  try {
    const loja = cleanText(event.queryStringParameters?.loja);
    if (!loja) {
      return json(400, { ok: false, error: "Loja nao informada." });
    }

    const empresa = await findCompany(supabaseUrl, serviceRoleKey, loja);
    if (!empresa) {
      return json(404, { ok: false, error: "Loja nao encontrada." });
    }

    if (empresa.status !== "ativo") {
      return json(403, { ok: false, error: "Catalogo indisponivel no momento." });
    }

    const [settings, categorias, produtos] = await Promise.all([
      getSettings(supabaseUrl, serviceRoleKey, empresa.id),
      listCategories(supabaseUrl, serviceRoleKey, empresa.id),
      listProducts(supabaseUrl, serviceRoleKey, empresa.id)
    ]);

    return json(200, {
      ok: true,
      empresa: sanitizeCompany(empresa),
      configuracao: settings || defaultSettings(empresa),
      categorias,
      produtos
    });
  } catch (error) {
    console.error("Erro ao carregar catalogo publico", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Nao foi possivel carregar o catalogo agora."
    });
  }
};

async function findCompany(supabaseUrl, serviceRoleKey, loja) {
  const field = loja.startsWith("cus_") ? "asaas_customer_id" : "id";
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `empresas?select=*&${field}=eq.${encodeURIComponent(loja)}&limit=1`
  );

  return rows[0] || null;
}

async function getSettings(supabaseUrl, serviceRoleKey, empresaId) {
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `lojas_config?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&limit=1`
  );

  return rows[0] || null;
}

async function listCategories(supabaseUrl, serviceRoleKey, empresaId) {
  return supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `categorias?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&ativo=eq.true&order=nome.asc`
  );
}

async function listProducts(supabaseUrl, serviceRoleKey, empresaId) {
  return supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `produtos?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&ativo=eq.true&order=novidade.desc&order=nome.asc`
  );
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

  if (response.status === 204) return [];

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function sanitizeCompany(empresa) {
  return {
    id: empresa.id,
    nome: empresa.nome,
    responsavel: empresa.responsavel,
    telefone: empresa.telefone,
    email: empresa.email,
    asaas_customer_id: empresa.asaas_customer_id
  };
}

function defaultSettings(empresa) {
  return {
    nome_publico: empresa.nome,
    whatsapp: empresa.telefone,
    site: "",
    instagram: "",
    logo_url: "",
    capa_url: "",
    cor_primaria: "#0f2733",
    cor_secundaria: "#0e7a5f",
    cor_destaque: "#f7bd16"
  };
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
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
