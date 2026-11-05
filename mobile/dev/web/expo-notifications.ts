/* eslint-disable @typescript-eslint/require-await -- stand-ins keep the native modules' async signatures */
/**
 * Web QA stand-in for expo-notifications (see metro.config.js): permission
 * is granted, so no screen shows its "turn on alerts" state, and nothing is
 * ever delivered.
 */

export enum PermissionStatus {
  DENIED = 'denied',
  GRANTED = 'granted',
  UNDETERMINED = 'undetermined',
}

export enum AndroidImportance {
  MIN = 1,
  LOW = 2,
  DEFAULT = 3,
  HIGH = 4,
  MAX = 5,
}

const granted = {
  status: PermissionStatus.GRANTED,
  granted: true,
  canAskAgain: true,
  expires: 'never',
};
const subscription = { remove: () => {} };

export const getPermissionsAsync = async () => granted;
export const requestPermissionsAsync = async () => granted;
export const setNotificationHandler = () => {};
export const setNotificationChannelAsync = async () => null;
export const setBadgeCountAsync = async () => true;
export const getBadgeCountAsync = async () => 0;
export const dismissNotificationAsync = async () => {};
export const dismissAllNotificationsAsync = async () => {};
export const getPresentedNotificationsAsync = async () => [];
export const scheduleNotificationAsync = async () => 'web';
export const cancelScheduledNotificationAsync = async () => {};
export const getDevicePushTokenAsync = async () => ({ type: 'web', data: '' });
export const getExpoPushTokenAsync = async () => ({ type: 'expo', data: '' });
export const getLastNotificationResponse = () => null;
export const getLastNotificationResponseAsync = async () => null;
export const useLastNotificationResponse = () => null;
export const addNotificationResponseReceivedListener = () => subscription;
export const addNotificationReceivedListener = () => subscription;
export const addPushTokenListener = () => subscription;
export const setNotificationCategoryAsync = async () => null;
