"use client";

import { useEffect, useSyncExternalStore } from "react";
import { isLanguage, LANGUAGES, LANGUAGE_STORAGE_KEY, translate, type Language } from "@/lib/ui-language";
import "./ui-language.css";

let language: Language = "zh";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => language;
const serverSnapshot = (): Language => "zh";

function selectLanguage(next: Language) {
  if (language === next) return;
  language = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : next;
  for (const listener of listeners) listener();
}

// Stable identity: adding translated messages to a callback must not restart polling or cameras.
export function t(source: string, values?: Record<string, string | number | null | undefined>) {
  return translate(language, source, values);
}

export function taskText(name: string | null | undefined, code?: string) {
  if (!name) return "—";
  if (code && !["SCAN", "SINGLE-SCAN", "TODO", "WAREHOUSE", "CLEAN"].includes(code)) return name;
  const paused = name.endsWith(" · 已暂停");
  const base = paused ? name.slice(0, -" · 已暂停".length) : name;
  const known = ["仓务", "混件扫描", "单件扫描", "问题单", "清洁"].includes(base);
  const label = known ? t(base) : !code && base.startsWith("波次 ") ? t("波次 {0}", {0: base.slice(3)}) : base;
  return paused ? t("{0} · 已暂停", {0: label}) : label;
}

export function durationText(source: string) {
  const match = /^(\d+)小时 (\d+)分$/.exec(source);
  return match ? t("{0}小时 {1}分", {0: match[1], 1: match[2]}) : source;
}

export function useLanguage() {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return { language: current, t };
}

export function LocalizedText({text}: {text: string}) {
  useLanguage();
  return t(text);
}

export default function LanguageButton() {
  const { language: current } = useLanguage();
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (isLanguage(stored)) selectLanguage(stored);
    } catch { /* Private browsers may disable local storage; switching still works. */ }
  }, []);
  const next = LANGUAGES[(LANGUAGES.indexOf(current) + 1) % LANGUAGES.length];
  const nextName = { zh: "中文", en: "English", es: "Español" }[next];
  return <button type="button" className="ui-language-button" title={`中文 / English / Español → ${nextName}`} aria-label={`Language: ${current}. ${nextName}`} onPointerDown={event => event.preventDefault()} onClick={() => {
    selectLanguage(next);
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Keep the in-memory choice. */ }
  }}><span aria-hidden="true">◎</span> {{zh:"中",en:"EN",es:"ES"}[current]}</button>;
}
