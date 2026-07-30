import { Alert, Platform } from "react-native";

export const confirmAction = (
  title: string,
  message: string,
  onConfirm: () => void,
  confirmText = "Delete",
  style: "destructive" | "default" | "cancel" = "destructive"
) => {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: confirmText, style, onPress: onConfirm },
    ]);
  }
};

export const showAlert = (title: string, message: string) => {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      window.alert(`${title}\n\n${message}`);
    }
  } else {
    Alert.alert(title, message);
  }
};

export const promptPartyType = (onCustomer: () => void, onSupplier: () => void) => {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      const isCustomer = window.confirm("Create a Customer or Supplier?\n\nPress OK for Customer, Cancel for Supplier.");
      if (isCustomer) onCustomer();
      else onSupplier();
    }
  } else {
    Alert.alert("Create Party", "Create Customer or Supplier?", [
      { text: "Cancel", style: "cancel" },
      { text: "Customer", onPress: onCustomer },
      { text: "Supplier", onPress: onSupplier },
    ]);
  }
};
