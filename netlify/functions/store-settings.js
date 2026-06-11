exports.handler = async (event) => {
  if (!["GET", "PATCH"].includes(event.httpMethod)) {
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
    const requestData = event.httpMethod === "GET"
      ? getQueryParams(event)
      : JSON.parse(event.body || "{}");

    const empresa = await validateStoreAccess(supabaseUrl, serviceRoleKey, requestData);
    if (empresa.error) return empresa.error;

    if (event.httpMethod === "GET") {
      const settings = await getSettings(supabaseUrl, serviceRoleKey, empresa.id);
      return json(200, { ok: true, empresa, configuracao: settings });
    }

    const normalized = normalizeSettings(requestData, empresa.id);
    const saved = await saveSettings(supabaseUrl, serviceRoleKey, normalized);

    return json(200, {
      ok: true,
      empresa,
      configuracao: saved
    });
  } catch (error) {
    console.error("Erro ao salvar configuracao da loja", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: "Nao foi possivel salvar os dados da loja agora."
    });
  }
};

async function validateStoreAccess(supabaseUrl, serviceRoleKey, payload) {
  const documento = onlyDigits(payload.documento);
  const acesso = cleanText(payload.acesso)?.toLowerCase() || "";

  if (!documento || ![11, 14].includes(documento.length)) {
    return { error: json(400, { ok: false, error: "Informe CPF ou CNPJ com 11 ou 14 digitos." }) };
  }

  if (!acesso) {
    return { error: json(400, { ok: false, error: "Informe e-mail ou WhatsApp cadastrado." }) };
  }

  const empresas = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `empresas?select=*&documento=eq.${encodeURIComponent(documento)}&limit=1`
  );
  const empresa = empresas[0];

  if (!empresa) {
    return { error: json(404, { ok: false, error: "Cadastro da empresa nao encontrado." }) };
  }

  const acessoNormalizado = onlyDigits(acesso) || acesso;
  const emailConfere = empresa.email && empresa.email.toLowerCase() === acesso;
  const telefoneConfere = empresa.telefone && onlyDigits(empresa.telefone) === acessoNormalizado;

  if (!emailConfere && !telefoneConfere) {
    return { error: json(401, { ok: false, error: "E-mail ou WhatsApp nao confere com o cadastro da empresa." }) };
  }

  if (empresa.status !== "ativo") {
    return { error: json(403, { ok: false, error: "Assinatura ainda nao esta ativa." }) };
  }

  return empresa;
}

async function getSettings(supabaseUrl, serviceRoleKey, empresaId) {
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `lojas_config?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&limit=1`
  );

  return rows[0] || null;
}

async function saveSettings(supabaseUrl, serviceRoleKey, settings) {
  const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, "lojas_config", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify([settings])
  });

  return rows[0] || null;
}

function normalizeSettings(payload, empresaId) {
  return {
    empresa_id: empresaId,
    nome_publico: cleanText(payload.nome_publico),
    whatsapp: onlyDigits(payload.whatsapp),
    site: cleanText(payload.site),
    instagram: cleanText(payload.instagram),
    logo_url: cleanText(payload.logo_url),
    capa_url: cleanText(payload.capa_url),
    cor_primaria: normalizeColor(payload.cor_primaria, "#0f2733"),
    cor_secundaria: normalizeColor(payload.cor_secundaria, "#0e7a5f"),
    cor_destaque: normalizeColor(payload.cor_destaque, "#f7bd16"),
    updated_at: new Date().toISOString()
  };
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

function getQueryParams(event) {
  return event.queryStringParameters || {};
}

function normalizeColor(value, fallback) {
  const color = cleanText(value);
  return /^#[0-9a-f]{6}$/i.test(color || "") ? color : fallback;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function onlyDigits(value) {
  const text = String(value || "").replace(/\D/g, "");
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
