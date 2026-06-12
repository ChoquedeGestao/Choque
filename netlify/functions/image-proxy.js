exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Metodo nao permitido." });
  }

  const rawUrl = event.queryStringParameters?.url || "";
  const targetUrl = normalizeUrl(rawUrl);
  if (!targetUrl) {
    return json(400, { ok: false, error: "Informe uma URL de imagem valida." });
  }

  try {
    const firstResponse = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 ChoqueDeGestaoImageProxy/1.0",
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!firstResponse.ok) {
      return json(502, { ok: false, error: "Nao foi possivel abrir o link da imagem." });
    }

    const contentType = firstResponse.headers.get("content-type") || "";
    if (contentType.toLowerCase().startsWith("image/")) {
      return imageResponse(firstResponse, contentType);
    }

    const html = await firstResponse.text();
    const previewUrl = extractPreviewImage(html, firstResponse.url || targetUrl);
    if (!previewUrl) {
      return json(415, { ok: false, error: "O link informado nao contem uma imagem publica." });
    }

    const imageResponseData = await fetch(previewUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 ChoqueDeGestaoImageProxy/1.0",
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!imageResponseData.ok) {
      return json(502, { ok: false, error: "Nao foi possivel abrir a imagem encontrada no link." });
    }

    const previewType = imageResponseData.headers.get("content-type") || "image/jpeg";
    if (!previewType.toLowerCase().startsWith("image/")) {
      return json(415, { ok: false, error: "A previa encontrada nao e uma imagem valida." });
    }

    return imageResponse(imageResponseData, previewType);
  } catch (error) {
    console.error("Erro ao carregar imagem externa", { message: error.message });
    return json(500, { ok: false, error: "Nao foi possivel processar a imagem agora." });
  }
};

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withProtocol = /^https?:\/\//i.test(text)
    ? text
    : /^\/\//.test(text)
      ? `https:${text}`
      : /^www\./i.test(text)
        ? `https://${text}`
        : "";

  if (!withProtocol) return "";

  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (isBlockedHost(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

async function imageResponse(response, contentType) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400"
    },
    body: buffer.toString("base64"),
    isBase64Encoded: true
  };
}

function extractPreviewImage(html, baseUrl) {
  const candidates = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i
  ];

  for (const pattern of candidates) {
    const match = String(html || "").match(pattern);
    if (match?.[1]) {
      try {
        return new URL(decodeHtml(match[1]), baseUrl).toString();
      } catch {
        return "";
      }
    }
  }

  return "";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(payload)
  };
}
