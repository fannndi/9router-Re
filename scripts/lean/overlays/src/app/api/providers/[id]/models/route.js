import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Lean fork: the only stored connections are custom OpenAI/Anthropic-compatible
// nodes (OpenCode Free is a virtual no-auth connection with no DB row), so this
// route only needs the two compatible-provider catalogs.

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

async function fetchOpenAICompatibleModels(connection) {
  const baseUrl = connection.providerSpecificData?.baseUrl;
  if (!baseUrl) {
    return { error: "No base URL configured for OpenAI compatible provider", status: 400 };
  }

  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${connection.apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.log(`Error fetching models from ${connection.provider}:`, errorText);
    return { error: `Failed to fetch models: ${response.status}`, status: response.status };
  }

  return { models: parseOpenAIStyleModels(await response.json()) };
}

async function fetchAnthropicCompatibleModels(connection) {
  let baseUrl = connection.providerSpecificData?.baseUrl;
  if (!baseUrl) {
    return { error: "No base URL configured for Anthropic compatible provider", status: 400 };
  }

  baseUrl = baseUrl.replace(/\/$/, "");
  if (baseUrl.endsWith("/messages")) {
    baseUrl = baseUrl.slice(0, -9);
  }

  const url = `${baseUrl}/models`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": connection.apiKey,
      "anthropic-version": "2023-06-01",
      "Authorization": `Bearer ${connection.apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.log(`Error fetching models from ${connection.provider}:`, errorText);
    return { error: `Failed to fetch models: ${response.status}`, status: response.status };
  }

  return { models: parseOpenAIStyleModels(await response.json()) };
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    let result;
    if (isOpenAICompatibleProvider(connection.provider)) {
      result = await fetchOpenAICompatibleModels(connection);
    } else if (isAnthropicCompatibleProvider(connection.provider)) {
      result = await fetchAnthropicCompatibleModels(connection);
    } else {
      return NextResponse.json(
        { error: `Provider ${connection.provider} does not support models listing` },
        { status: 400 }
      );
    }

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }

    return NextResponse.json({
      provider: connection.provider,
      connectionId: connection.id,
      models: result.models,
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
