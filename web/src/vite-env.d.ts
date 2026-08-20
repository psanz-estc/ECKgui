/// <reference types="vite/client" />

declare module "@elastic/eui/es/components/icon/icon" {
  export function appendIconComponentCache(
    iconTypeToIconComponentMap: Record<string, unknown>,
  ): void;
}

declare module "@elastic/eui/es/components/icon/assets/*" {
  export const icon: unknown;
}
