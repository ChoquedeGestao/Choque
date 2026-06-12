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
      const produtos = await listProducts(supabaseUrl, serviceRoleKey, empresa.id);
      return json(200, { ok: true, empresa, produtos });
    }

    if (event.httpMethod === "POST") {
      const produto = await createProduct(supabaseUrl, serviceRoleKey, empresa.id, requestData);
      return json(200, { ok: true, empresa, produto });
    }

    if (event.httpMethod === "DELETE") {
      const produto = await deleteProduct(supabaseUrl, serviceRoleKey, empresa.id, requestData);
      return json(200, { ok: true, empresa, produto });
    }

    const produto = await updateProduct(supabaseUrl, serviceRoleKey, empresa.id, requestData);
    return json(200, { ok: true, empresa, produto });
  } catch (error) {
    console.error("Erro ao salvar produto", {
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

async function listProducts(supabaseUrl, serviceRoleKey, empresaId) {
  return supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `produtos?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&order=novidade.desc&order=nome.asc`
  );
}

async function createProduct(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const product = await buildProductPayload(supabaseUrl, serviceRoleKey, empresaId, payload, true);

  const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, "produtos", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify([product])
  });

  return rows[0] || null;
}

async function updateProduct(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const id = cleanText(payload.id);
  if (!id) {
    throw new Error("Produto nao informado.");
  }

  const product = await buildProductPayload(supabaseUrl, serviceRoleKey, empresaId, payload, false);
  product.updated_at = new Date().toISOString();

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `produtos?id=eq.${encodeURIComponent(id)}&empresa_id=eq.${encodeURIComponent(empresaId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(product)
    }
  );

  if (!rows[0]) {
    throw new Error("Produto nao encontrado.");
  }

  return rows[0];
}

async function deleteProduct(supabaseUrl, serviceRoleKey, empresaId, payload) {
  const id = cleanText(payload.id);
  if (!id) {
    throw new Error("Produto nao informado.");
  }

  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `produtos?id=eq.${encodeURIComponent(id)}&empresa_id=eq.${encodeURIComponent(empresaId)}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=representation"
      }
    }
  );

  if (!rows[0]) {
    throw new Error("Produto nao encontrado.");
  }

  return rows[0];
}

async function buildProductPayload(supabaseUrl, serviceRoleKey, empresaId, payload, requireName) {
  const product = {};

  if (requireName || payload.nome !== undefined) {
    product.nome = cleanText(payload.nome);
    if (!product.nome) throw new Error("Informe o nome do produto.");
  }

  if (requireName || payload.preco !== undefined) {
    product.preco = parseMoney(payload.preco);
  }

  if (payload.descricao !== undefined) product.descricao = cleanText(payload.descricao);
  if (payload.imagem_1 !== undefined) product.imagem_1 = cleanText(payload.imagem_1);
  if (payload.imagem_2 !== undefined) product.imagem_2 = cleanText(payload.imagem_2);
  if (payload.imagem_3 !== undefined) product.imagem_3 = cleanText(payload.imagem_3);
  if (payload.imagem_4 !== undefined) product.imagem_4 = cleanText(payload.imagem_4);
  if (payload.ativo !== undefined) product.ativo = toBoolean(payload.ativo);
  if (payload.novidade !== undefined) product.novidade = toBoolean(payload.novidade);

  if (requireName) {
    product.empresa_id = empresaId;
    product.ativo = payload.ativo === undefined ? true : toBoolean(payload.ativo);
    product.novidade = payload.novidade === undefined ? false : toBoolean(payload.novidade);
  }

  if (payload.categoria_id !== undefined || payload.categoria_nome !== undefined) {
    product.categoria_id = await resolveCategory(supabaseUrl, serviceRoleKey, empresaId, payload.categoria_id, payload.categoria_nome, null);
  }

  if (payload.subcategoria_id !== undefined || payload.subcategoria_nome !== undefined) {
    product.subcategoria_id = await resolveCategory(
      supabaseUrl,
      serviceRoleKey,
      empresaId,
      payload.subcategoria_id,
      payload.subcategoria_nome,
      product.categoria_id || payload.categoria_id || null
    );
  }

  return product;
}

async function resolveCategory(supabaseUrl, serviceRoleKey, empresaId, categoryId, categoryName, parentId) {
  const id = cleanText(categoryId);
  if (id) {
    const rows = await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      `categorias?select=*&id=eq.${encodeURIComponent(id)}&empresa_id=eq.${encodeURIComponent(empresaId)}&limit=1`
    );
    const category = rows[0];
    if (!category) throw new Error("Categoria informada nao foi encontrada.");
    if (parentId && category.parent_id !== parentId) throw new Error("Subcategoria nao pertence a categoria selecionada.");
    return category.id;
  }

  const name = cleanText(categoryName);
  if (!name) return null;

  const path = parentId
    ? `categorias?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&parent_id=eq.${encodeURIComponent(parentId)}&nome=ilike.${encodeURIComponent(name)}&limit=1`
    : `categorias?select=*&empresa_id=eq.${encodeURIComponent(empresaId)}&parent_id=is.null&nome=ilike.${encodeURIComponent(name)}&limit=1`;
  const rows = await supabaseRequest(supabaseUrl, serviceRoleKey, path);
  return rows[0]?.id || null;
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

function parseMoney(value) {
  const raw = String(value ?? "0").trim();
  let normalized = raw
    .replace(/\s/g, "")
    .replace(/[R$]/gi, "")
    .replace(/[^\d,.-]/g, "");

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");
    normalized = lastComma > lastDot
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else if (hasComma) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }

  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Informe um preco valido.");
  }
  return number;
}

function toBoolean(value) {
  if (value === true || value === "true" || value === "sim" || value === "on" || value === "1") return true;
  return false;
}

function friendlyError(message) {
  if (message.includes("duplicate key")) return "Este produto ja existe nesta loja.";
  if (message.includes("Informe")) return message;
  if (message.includes("Produto")) return message;
  if (message.includes("Categoria")) return message;
  if (message.includes("Subcategoria")) return message;
  return "Nao foi possivel salvar o produto agora.";
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
