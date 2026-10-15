import protobuf from "protobufjs";
import { ChallengeError, FetchTimeoutError } from "./errors.ts";

export type FetchApi = (url: string, init?: RequestInit) => Promise<Response>;

interface ProtoInit {
  proto: string;
  requestType: string;
  requestData?: Record<string, unknown>;
  responseType: string;
}

const isFatal = (error: unknown): boolean => error instanceof FetchTimeoutError || error instanceof ChallengeError;

export const buildFetchModule = (fetchApi: FetchApi) => {
  const fetchText = async (url: string, init?: RequestInit, encoding = "utf-8") => {
    try {
      const response = await fetchApi(url, init);
      if (!response.ok) return "";
      return new TextDecoder(encoding).decode(await response.arrayBuffer());
    } catch (error) {
      if (isFatal(error)) throw error;
      return "";
    }
  };

  const fetchFile = async (url: string, init?: RequestInit) => {
    try {
      const response = await fetchApi(url, init);
      if (!response.ok) return "";
      return Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (error) {
      if (isFatal(error)) throw error;
      return "";
    }
  };

  const fetchProto = async <T>(protoInit: ProtoInit, url: string, init?: RequestInit): Promise<T> => {
    const root = protobuf.parse(protoInit.proto).root;
    const requestType = root.lookupType(protoInit.requestType);
    const validationError = requestType.verify(protoInit.requestData ?? {});
    if (validationError) throw new Error("Invalid Proto");
    const payload = requestType.encode(protoInit.requestData ?? {}).finish();
    const framed = new Uint8Array(payload.length + 5);
    new DataView(framed.buffer).setUint32(1, payload.length);
    framed.set(payload, 5);
    const response = await fetchApi(url, {
      ...init,
      method: "POST",
      body: framed,
    });
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    const length = new DataView(responseBytes.buffer, responseBytes.byteOffset, responseBytes.byteLength).getUint32(1);
    return root.lookupType(protoInit.responseType).decode(responseBytes.slice(5, 5 + length)) as T;
  };

  return { fetchApi, fetchText, fetchFile, fetchProto };
};
