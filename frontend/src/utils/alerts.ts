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
