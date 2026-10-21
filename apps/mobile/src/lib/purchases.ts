/**
 * Pro bought in the app: Apple In-App Purchase and Google Play Billing through RevenueCat. The
 * server mirrors RevenueCat (ee/billing/src/revenuecat.ts), so the plan follows the account,
 * not the device. Purchases are logged in with the Myrel user id for that reason.
 */
import { Platform } from "react-native";
import Purchases, { PACKAGE_TYPE, type PurchasesPackage } from "react-native-purchases";

export { PACKAGE_TYPE };

// Public SDK keys of the RevenueCat project, set in the EAS environment. Without one the app sells nothing.
const apiKey = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

export const store = Platform.OS === "ios" ? "app_store" : "play_store";

/** Whether this build can sell plans at all; the server must say so too (BillingSummary.storeSales). */
export const canSell = Boolean(apiKey) && (Platform.OS === "ios" || Platform.OS === "android");

let loggedIn: string | null = null;

async function as(userId: string) {
  if (loggedIn === null) {
    Purchases.configure({ apiKey: apiKey!, appUserID: userId });
  } else if (loggedIn !== userId) {
    await Purchases.logIn(userId);
  }
  loggedIn = userId;
}

/** The plans on sale: the current offering's monthly and yearly packages, with the store's local prices. */
export async function packages(userId: string): Promise<PurchasesPackage[]> {
  await as(userId);
  const offerings = await Purchases.getOfferings();
  const order = [PACKAGE_TYPE.MONTHLY, PACKAGE_TYPE.ANNUAL];
  return (offerings.current?.availablePackages ?? [])
    .filter((p) => order.includes(p.packageType))
    .sort((a, b) => order.indexOf(a.packageType) - order.indexOf(b.packageType));
}

/** Buys a package; false when the person backed out of the store's sheet. */
export async function buy(userId: string, pkg: PurchasesPackage): Promise<boolean> {
  await as(userId);
  try {
    await Purchases.purchasePackage(pkg);
    return true;
  } catch (err) {
    if ((err as { userCancelled?: boolean | null }).userCancelled) return false;
    throw err;
  }
}

/** Restores this store account's purchases to the signed-in person; true when one grants a plan. */
export async function restore(userId: string): Promise<boolean> {
  await as(userId);
  const info = await Purchases.restorePurchases();
  return Object.keys(info.entitlements.active).length > 0;
}

/** The store's own page for managing (or canceling) the subscription. */
export function manageUrl(source: "app_store" | "play_store"): string {
  return source === "app_store"
    ? "https://apps.apple.com/account/subscriptions"
    : "https://play.google.com/store/account/subscriptions?package=io.fibteq.myrel";
}
