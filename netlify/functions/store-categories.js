exports.handler = async (event) => {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(event.httpMethod)) {
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
      ? event.queryStringParameters || {}
      : JSON.parse(event.body || "{}");

    const empresa = await validateStoreAccess(supabaseUrl, serviceRoleKey, requestData);
    if (empresa.error) return empresa.error;

    if (event.httpMethod === "GET") {
      const categorias = await listCategories(supabaseUrl, serviceRoleKey, empresa.id);
      return json(200, { ok: true, empresa, categorias });
    }

    if (event.httpMethod === "POST") {
      const categoria = await createCategory(supabaseUrl, serviceRoleKey, empresa.id, requestData);
      return json(200, { ok: true, empresa, categoria });
    }

    if (event.httpMethod === "DELETE") {
      const categoria = await deleteCategory(supabaseUrl, serviceRoleKey, empresa.id, requestData);
      return json(200, { ok: true, empresa, categoria });
    }

    const categoria = await updateCategory(supabaseUrl, serviceRoleKey, empresa.id, requestData);
    return json(200, { ok: true, empresa, categoria });
  } catch (error) {
    console.error("Erro ao salvar categoria", {
      message: error.message
    });

    return json(500, {
      ok: false,
      error: friendlyError(error.message)
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

async function listCategories(supabaseUrl, serviceRoleKey, empresaId) {
  return supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `categorias?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&order=nome.asc`
  );
}

async function createCategory(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const nome = cleanText(payload.nome);
  const parentId = cleanText(payload.parent_id);

  if (!nome) {
    throw new Error("Informe o nome da categoria.");
  }

  if (parentId) {
    await validateParentCategory(supabaseUrl, serviceRoleKey, empresaId, parentId);
  }

  const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, "categorias", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify([{
      empresa_id: empresaId,
      nome,
      parent_id: parentId || null,
      ativo: payload.ativo !== false
    }])
  });

  return rows[0] || null;
}

async function updateCategory(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const id = cleanText(payload.id);
  if (!id) {
    throw new Error("Categoria nao informada.");
  }

  const update = {
    updated_at: new Date().toISOString()
  };

  if (payload.nome !== undefined) {
    update.nome = cleanText(payload.nome);
    if (!update.nome) throw new Error("Informe o nome da categoria.");
  }

  if (payload.parent_id !== undefined) {
    const parentId = cleanText(payload.parent_id);
    if (parentId) await validateParentCategory(supabaseUrl, serviceRoleKey, empresaId, parentId);
    update.parent_id = parentId || null;
  }

  if (payload.ativo !== undefined) {
    update.ativo = Boolean(payload.ativo);
  }

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `categorias?id=eq.${encodeURIComponent(id)}&empresa_id=eq.${encodeURIComponent(empresaId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(update)
    }
  );

  if (!rows[0]) {
    throw new Error("Categoria nao encontrada.");
  }

  return rows[0];
}

async function deleteCategory(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const id = cleanText(payload.id);
  if (!id) {
    throw new Error("Categoria nao informada.");
  }

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `categorias?id=eq.${encodeURIComponent(id)}&empresa_id=eq.${encodeURIComponent(empresaId)}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=representation"
      }
    }
  );

  if (!rows[0]) {
    throw new Error("Categoria nao encontrada.");
  }

  return rows[0];
}

async function validateParentCategory(supabaseUrl, serviceRoleKey, empresaId, parentId) {
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `categorias?select=*&id=eq.${encodeURIComponent(parentId)}&empresa_id=eq.${encodeURIComponent(empresaId)}&limit=1`
  );
  const parent = rows[0];

  if (!parent) {
    throw new Error("Categoria superior nao encontrada.");
  }

  if (parent.parent_id) {
    throw new Error("Cadastre subcategorias somente dentro de uma categoria principal.");
  }
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

function friendlyError(message) {
  if (message.includes("duplicate key")) return "Esta categoria ja existe nesta loja.";
  if (message.includes("Informe")) return message;
  if (message.includes("Categoria")) return message;
  return "Nao foi possivel salvar a categoria agora.";
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
