import * as Print from 'expo-print';
import { Platform } from 'react-native';

export async function printHtml(html: string, title: string = 'Document') {
  if (Platform.OS === 'web') {
    // expo-print does not support printing custom HTML on the web.
    // It defaults to printing the current browser window (the app UI).
    // Instead, we open a hidden iframe or a new window, write the HTML, and print it.
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.document.title = title;
      printWindow.focus();
      
      // Wait for fonts and images to load before triggering print
      setTimeout(() => {
        printWindow.print();
        printWindow.close();
      }, 500);
    }
  } else {
    await Print.printAsync({ html });
  }
}
