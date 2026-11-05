/* eslint-disable @typescript-eslint/require-await -- stand-ins keep the native modules' async signatures */
/** Web QA stand-in for expo-secure-store: `localStorage` (see metro.config.js). */
import { local } from './storage';

const k = (key: string) => `securestore:${key}`;

export const WHEN_UNLOCKED = 0;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
export const AFTER_FIRST_UNLOCK = 2;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 3;

export const getItemAsync = async (key: string) => local.get(k(key));
export const setItemAsync = async (key: string, value: string) => local.set(k(key), value);
export const deleteItemAsync = async (key: string) => local.remove(k(key));
export const getItem = (key: string) => local.get(k(key));
export const setItem = (key: string, value: string) => local.set(k(key), value);
export const isAvailableAsync = async () => true;
