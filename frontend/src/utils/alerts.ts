import { Alert, Platform } from "react-native";

export const confirmAction = (title: string, message: string, onConfirm: () => void, confirmText = "Delete", style: "destructive" | "default" | "cancel" = "destructive") => {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: confirmText, style, onPress: onConfirm },
    ]);
  }
};
