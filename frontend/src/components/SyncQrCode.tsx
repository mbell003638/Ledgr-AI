import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '@/src/context/ThemeContext';
import { encodeLedgrSyncQrInvite, type LedgrSyncQrInvite } from '@/src/sync/qrEnrollment';

export function SyncQrCode({ invite }: { invite: Omit<LedgrSyncQrInvite, 'kind' | 'version'> }) {
  const theme = useTheme();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setSvg(''); setError('');
    QRCode.toString(encodeLedgrSyncQrInvite(invite), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0b1110', light: '#ffffff' } })
      .then((value) => { if (active) setSvg(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'The QR invitation could not be rendered.'); });
    return () => { active = false; };
  }, [invite]);
  if (error) return <Text style={{ color: theme.color.error || '#c53b3b', fontSize: 12 }}>{error}</Text>;
  return <View accessibilityLabel="Private sync QR invitation" style={{ width: 238, height: 238, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', padding: 10 }}>{svg ? <SvgXml xml={svg} width="218" height="218" /> : <ActivityIndicator color={theme.color.brandPrimary} />}</View>;
}
