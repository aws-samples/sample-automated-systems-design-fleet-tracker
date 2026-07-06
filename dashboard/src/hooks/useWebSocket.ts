import { useEffect, useRef, useState, useCallback } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import type { WsMessage } from "../types";

const WS_URL = import.meta.env.VITE_WS_URL;

export function useWebSocket(onMessage: (msg: WsMessage) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | undefined>(undefined);

  const connect = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;

      const ws = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log("WebSocket connected");
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsMessage;
          onMessage(data);
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        console.log("WebSocket disconnected, reconnecting...");
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        ws.close();
      };
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    }
  }, [onMessage]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}
