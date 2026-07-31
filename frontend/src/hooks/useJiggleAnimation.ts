import { useEffect } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';

export const useJiggleAnimation = (isEditing: boolean) => {
  const rotation = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (isEditing) {
      rotation.value = withRepeat(
        withSequence(
          withTiming(-1.4, { duration: 140, easing: Easing.ease }),
          withTiming(1.4, { duration: 140, easing: Easing.ease })
        ),
        -1,
        true
      );
      scale.value = withRepeat(
        withSequence(
          withTiming(0.98, { duration: 140, easing: Easing.ease }),
          withTiming(1.02, { duration: 140, easing: Easing.ease })
        ),
        -1,
        true
      );
    } else {
      rotation.value = withTiming(0, { duration: 150 });
      scale.value = withTiming(1, { duration: 150 });
    }
  }, [isEditing]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { rotateZ: `${rotation.value}deg` },
      { scale: scale.value },
    ],
  }));

  return animatedStyle;
};
