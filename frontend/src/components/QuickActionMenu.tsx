import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, Easing, interpolate, Extrapolation } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useTheme } from '@/src/context/ThemeContext';
import { LinearGradient } from 'expo-linear-gradient';

const { width, height } = Dimensions.get('window');

export default function QuickActionMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const router = useRouter();
  const theme = useTheme();

  const progress = useSharedValue(0);

  const toggleMenu = () => {
    if (isOpen) {
      progress.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.ease) });
      setIsOpen(false);
    } else {
      setIsOpen(true);
      progress.value = withSpring(1, { damping: 15, stiffness: 150 });
    }
  };

  const closeMenu = () => {
    if (isOpen) toggleMenu();
  };

  const overlayStyle = useAnimatedStyle(() => {
    return {
      opacity: progress.value,
      pointerEvents: progress.value > 0 ? 'auto' : 'none',
    };
  });

  const menuStyle = useAnimatedStyle(() => {
    return {
      opacity: progress.value,
      transform: [
        { translateY: interpolate(progress.value, [0, 1], [30, 0], Extrapolation.CLAMP) },
        { scale: interpolate(progress.value, [0, 1], [0.95, 1], Extrapolation.CLAMP) },
      ],
      pointerEvents: progress.value > 0 ? 'auto' : 'none',
    };
  });

  const fabIconStyle = useAnimatedStyle(() => {
    return {
      transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 45])}deg` }],
    };
  });

  return (
    <>
      {/* OVERLAY */}
      <Animated.View style={[styles.overlayContainer, overlayStyle]}>
        <Pressable style={styles.overlayPressable} onPress={closeMenu}>
          <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
        </Pressable>
      </Animated.View>

      {/* POPUP MENU */}
      <Animated.View style={[styles.menuContainer, menuStyle]}>
        <BlurView intensity={40} tint="dark" style={styles.menuBlur}>
          <View style={[styles.menuInner, { borderColor: 'rgba(255,255,255,0.15)' }]}>
            
            {/* AI Action */}
            <Pressable 
              style={({ pressed }) => [styles.aiAction, pressed && { opacity: 0.8 }]} 
              onPress={() => { closeMenu(); router.push('/ask'); }}
            >
              <LinearGradient 
                colors={['rgba(253, 186, 33, 0.2)', 'rgba(253, 186, 33, 0.05)']}
                style={StyleSheet.absoluteFill}
              />
              <Text style={styles.aiIcon}>✨</Text>
              <Text style={styles.aiText}>Scan Receipt or Ask AI</Text>
            </Pressable>

            <View style={{ height: 8 }} />

            {/* Action Row: Invoice */}
            <Pressable style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: 'rgba(255,255,255,0.08)' }]} onPress={() => { closeMenu(); alert("Coming soon"); }}>
              <View style={[styles.actionIconCircle, { backgroundColor: 'rgba(74, 222, 128, 0.15)' }]}>
                <Text style={{ fontSize: 20 }}>🧾</Text>
              </View>
              <View style={styles.actionDetails}>
                <Text style={styles.actionTitle}>Create Invoice</Text>
                <Text style={styles.actionSubtitle}>Record a new sale</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
            </Pressable>

            {/* Action Row: Expense */}
            <Pressable style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: 'rgba(255,255,255,0.08)' }]} onPress={() => { closeMenu(); alert("Coming soon"); }}>
              <View style={[styles.actionIconCircle, { backgroundColor: 'rgba(239, 68, 68, 0.15)' }]}>
                <Text style={{ fontSize: 20 }}>💸</Text>
              </View>
              <View style={styles.actionDetails}>
                <Text style={styles.actionTitle}>Add Expense</Text>
                <Text style={styles.actionSubtitle}>Log a bill or purchase</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
            </Pressable>
            
            {/* Action Row: Payment */}
            <Pressable style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: 'rgba(255,255,255,0.08)' }]} onPress={() => { closeMenu(); alert("Coming soon"); }}>
              <View style={[styles.actionIconCircle, { backgroundColor: 'rgba(59, 130, 246, 0.15)' }]}>
                <Text style={{ fontSize: 20 }}>💵</Text>
              </View>
              <View style={styles.actionDetails}>
                <Text style={styles.actionTitle}>Receive Payment</Text>
                <Text style={styles.actionSubtitle}>Log incoming funds</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
            </Pressable>
            
            {/* Action Row: Party */}
            <Pressable style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: 'rgba(255,255,255,0.08)' }]} onPress={() => { closeMenu(); alert("Coming soon"); }}>
              <View style={[styles.actionIconCircle, { backgroundColor: 'rgba(168, 85, 247, 0.15)' }]}>
                <Text style={{ fontSize: 20 }}>👥</Text>
              </View>
              <View style={styles.actionDetails}>
                <Text style={styles.actionTitle}>Add Party</Text>
                <Text style={styles.actionSubtitle}>New customer or vendor</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
            </Pressable>

          </View>
        </BlurView>
      </Animated.View>

      {/* FAB */}
      <Pressable
        onPress={toggleMenu}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: isOpen ? theme.color.surfaceTertiary : theme.color.brandPrimary },
          pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
        ]}
      >
        <Animated.View style={fabIconStyle}>
          <Ionicons name="add" size={36} color={isOpen ? theme.color.onSurface : theme.color.onBrandPrimary} />
        </Animated.View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    position: 'absolute',
    top: -height, 
    left: -width,
    right: -width,
    bottom: -height,
    zIndex: 90,
  },
  overlayPressable: {
    flex: 1,
  },
  menuContainer: {
    position: 'absolute',
    bottom: 110, // Matches FAB bottom slightly
    left: 20,
    right: 20,
    zIndex: 100,
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.6,
    shadowRadius: 48,
    elevation: 10,
    transformOrigin: 'bottom', // helps with scaling
  },
  menuBlur: {
    flex: 1,
    backgroundColor: 'rgba(20, 20, 22, 0.45)', 
  },
  menuInner: {
    padding: 12,
    borderWidth: 1,
    borderRadius: 32,
  },
  aiAction: {
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(253, 186, 33, 0.3)',
    overflow: 'hidden',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 4,
  },
  aiIcon: {
    fontSize: 24,
    marginRight: 12,
    textShadowColor: 'rgba(253, 186, 33, 0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  aiText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FDBA21',
    letterSpacing: 0.2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  actionIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  actionDetails: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 2,
  },
  actionSubtitle: {
    fontSize: 13,
    color: '#a1a1aa',
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 110, 
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 110,
  },
});
