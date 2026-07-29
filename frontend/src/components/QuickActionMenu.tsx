import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions, Modal } from 'react-native';
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
      setTimeout(() => setIsOpen(false), 250);
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
    };
  });

  const menuStyle = useAnimatedStyle(() => {
    return {
      opacity: progress.value,
      transform: [
        { translateY: interpolate(progress.value, [0, 1], [30, 0], Extrapolation.CLAMP) },
        { scale: interpolate(progress.value, [0, 1], [0.95, 1], Extrapolation.CLAMP) },
      ],
    };
  });

  const fabIconStyle = useAnimatedStyle(() => {
    return {
      transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 45])}deg` }],
    };
  });

  return (
    <>
      {/* FAB rendered absolutely over the tab bar */}
      <View style={styles.fabContainer}>
        <Pressable
          onPress={toggleMenu}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: isOpen ? theme.color.surfaceTertiary : theme.color.brandPrimary },
            { shadowColor: isOpen ? "#000" : theme.color.brandPrimary },
            pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
          ]}
        >
          <Animated.View style={fabIconStyle}>
            <Ionicons name="add" size={38} color={isOpen ? theme.color.onSurface : theme.color.onBrandPrimary} />
          </Animated.View>
        </Pressable>
      </View>

      {/* POPUP MENU MODAL */}
      <Modal transparent visible={isOpen} animationType="none" onRequestClose={closeMenu}>
        <Animated.View style={[styles.overlayContainer, overlayStyle]}>
          <Pressable style={styles.overlayPressable} onPress={closeMenu}>
            <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          </Pressable>
        </Animated.View>

        <Animated.View style={[styles.menuContainer, menuStyle]}>
          <View style={styles.menuSolid}>
            <View style={[styles.menuInner, { borderColor: 'rgba(255,255,255,0.15)' }]}>
              
              {/* AI Action */}
              <Pressable 
                style={({ pressed }) => [styles.aiAction, { borderColor: theme.color.brandPrimary + '4D' }, pressed && { opacity: 0.8 }]} 
                onPress={() => { closeMenu(); router.push('/ask'); }}
              >
                <LinearGradient 
                  colors={[theme.color.brandPrimary + '33', theme.color.brandPrimary + '0D']}
                  style={StyleSheet.absoluteFill}
                />
                <Text style={[styles.aiIcon, { textShadowColor: theme.color.brandPrimary + '80' }]}>✨</Text>
                <Text style={[styles.aiText, { color: theme.color.brandPrimary }]}>Scan Receipt or Ask AI</Text>
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
          </View>
        </Animated.View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayPressable: {
    flex: 1,
  },
  menuContainer: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    width: '90%',
    maxWidth: 400,
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.6,
    shadowRadius: 48,
    elevation: 10,
    transformOrigin: 'bottom',
  },
  menuSolid: {
    flex: 1,
    backgroundColor: '#141416', // Solid color as requested
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
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  aiText: {
    fontSize: 16,
    fontWeight: '600',
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
  fabContainer: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 40, // Protrudes exactly above the 88px tab bar
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 110,
  },
  fab: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 8,
  },
});
