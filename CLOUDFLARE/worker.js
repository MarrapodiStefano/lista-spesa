// BACKUP Cloudflare Worker — La Mia Spesa V3.1
// Secrets richiesti: GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, ADMIN_KEY

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...corsHeaders }
  });
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const token = env.GITHUB_TOKEN;
    const adminKey = env.ADMIN_KEY;
    const branch = "main";
    const filePath = "products-master.json";

    const githubApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const githubRawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

    if (!owner || !repo || !token || !adminKey) {
      return json({ success:false, error:"Configurazione Worker incompleta" }, 500);
    }

    const githubHeaders = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Lista-Spesa-Master"
    };

    if (request.method === "GET" && url.pathname === "/master") {
      try {
        const rawResponse = await fetch(githubRawUrl, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "Lista-Spesa-Master"
          },
          cf: { cacheTtl: 0, cacheEverything: false }
        });

        if (!rawResponse.ok) {
          return json({ success:false, error:`Impossibile scaricare la libreria Master (${rawResponse.status})` }, 500);
        }

        const rawText = await rawResponse.text();
        if (!rawText || !rawText.trim()) return json({ success:false, error:"La libreria Master ricevuta è vuota" }, 500);

        let products;
        try { products = JSON.parse(rawText); }
        catch (parseError) {
          return json({ success:false, error:"Il file products-master.json non contiene JSON valido", details:parseError.message }, 500);
        }

        if (!Array.isArray(products)) return json({ success:false, error:"Formato della libreria Master non valido" }, 500);

        let updatedAt = "";
        try {
          const metadataResponse = await fetch(githubApiUrl, { headers:githubHeaders });
          if (metadataResponse.ok) {
            const metadata = await metadataResponse.json();
            updatedAt = metadata.sha || "";
          }
        } catch (error) {
          console.log("Impossibile recuperare SHA:", error.message);
        }

        return json({ success:true, products, updatedAt });
      } catch (error) {
        return json({ success:false, error:error.message }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/master") {
      const providedKey = request.headers.get("X-Admin-Key");
      if (!providedKey || providedKey !== adminKey) return json({ success:false, error:"Non autorizzato" }, 401);

      try {
        const body = await request.json();
        if (!Array.isArray(body.products)) return json({ success:false, error:"Formato prodotti non valido" }, 400);

        const currentResponse = await fetch(githubApiUrl, { headers:githubHeaders });
        if (!currentResponse.ok) {
          const details = await currentResponse.text();
          return json({ success:false, error:"Impossibile recuperare il file attuale da GitHub", details }, 500);
        }

        const currentFile = await currentResponse.json();
        const newContent = JSON.stringify(body.products, null, 2);

        const updateData = {
          message:"Aggiornamento libreria Master prodotti",
          content:textToBase64(newContent),
          branch,
          sha:currentFile.sha
        };

        const updateResponse = await fetch(githubApiUrl, {
          method:"PUT",
          headers:{ ...githubHeaders, "Content-Type":"application/json" },
          body:JSON.stringify(updateData)
        });

        const updateResult = await updateResponse.json();
        if (!updateResponse.ok) {
          return json({ success:false, error:"GitHub non ha accettato l'aggiornamento", details:updateResult }, 500);
        }

        return json({ success:true, message:"Libreria Master aggiornata correttamente", updatedAt:updateResult.content?.sha || "" });
      } catch (error) {
        return json({ success:false, error:error.message }, 500);
      }
    }

    return json({ success:false, error:"Endpoint non trovato" }, 404);
  }
};