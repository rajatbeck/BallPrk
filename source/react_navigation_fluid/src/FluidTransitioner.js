import React from 'react';
import PropTypes from 'prop-types';
import { StyleSheet, Platform, Easing, I18nManager, Animated, PanResponder, InteractionManager } from 'react-native';
import { NavigationActions, Transitioner } from 'react-navigation';
import clamp from 'clamp';

import TransitionItemsView from './TransitionItemsView';
import TransitionRouteView from './TransitionRouteView';

const emptyFunction = () => {};

const ANIMATION_DURATION = 500;
const POSITION_THRESHOLD = 1 / 2;
const RESPOND_THRESHOLD = 20;

type SceneRenderedInfo = {
  key: string,
  isMounted: boolean,
};

class FluidTransitioner extends React.Component<*> {
  constructor(props) {
    super(props);

    this._onTransitionStart = this._onTransitionStart.bind(this);
    this._onSceneReady = this._onSceneReady.bind(this);
    this._transitionItemsViewOnLayout = this._transitionItemsViewOnLayout.bind(this);
    this._configureTransition = this._configureTransition.bind(this);
    this._getSceneTransitionConfiguration = this._getSceneTransitionConfiguration.bind(this);

    this._scenesReadyPromise = new Promise(resolve =>
      this._scenesReadyResolveFunc = resolve);
  }

  _scenes: Array<SceneRenderedInfo> = [];
  _scenesReadyResolveFunc: ?Function;
  _scenesReadyPromise: ?Promise<void>;
  _layoutsReady: boolean;
  _gestureStartValue = 0;
  _isResponding = false;
  _immediateIndex = null;
  _panResponder = null;

  static childContextTypes = {
    route: PropTypes.string,
    getTransitionConfig: PropTypes.func,
    onSceneReady: PropTypes.func,
  }

  _animatedSubscribeForNativeAnimation(animatedValue: Animated.Value) {
    if (!animatedValue) return;
    if (!this._configureTransition().useNativeDriver) return;
    if (Object.keys(animatedValue._listeners).length === 0) {
      animatedValue.addListener(emptyFunction);
    }
  }

  getChildContext() {
    return {
      route: this.props.navigation.state.routes[
        this.props.navigation.state.index].routeName,
      onSceneReady: this._onSceneReady,
      getTransitionConfig: this._getSceneTransitionConfiguration,
    };
  }

  render() {
    return (
      <Transitioner
        configureTransition={this._configureTransition}
        render={this._render.bind(this)}
        navigation={this.props.navigation}
        descriptors={this.props.descriptors}
        onTransitionStart={this._onTransitionStart}
      />
    );
  }

  _transitionItemsViewOnLayout() {
    this._layoutsReady = true;
    this._checkScenesAndLayouts();
  }

  _onSceneReady(key: string) {
    if (!this._scenesReadyResolveFunc) { return; }
    // check if this is a scene we are waiting for
    const sceneRenderInfo = this._scenes.find(sri => sri.key === key);
    if (sceneRenderInfo) sceneRenderInfo.isMounted = true;
    this._checkScenesAndLayouts();
  }

  _checkScenesAndLayouts() {
    if (this._layoutsReady && !this._scenes.find(sri => !sri.isMounted)) {
      if (this._scenesReadyResolveFunc) {
        this._scenesReadyResolveFunc();

        this._scenesReadyPromise = new Promise(resolve =>
          this._scenesReadyResolveFunc = resolve);
      }
    }
  }

  _onTransitionStart(): Promise<void> | void {
    if (this._scenesReadyPromise) { 
      return this._scenesReadyPromise; 
    }
  }

  shouldComponentUpdate(nextProps) {
    return this.props !== nextProps;
  }

  _configureTransition(props, prevProps) {
    let sceneTransitionConfig = {};
    if (props) {
      let moveForward = true;
      if (prevProps && prevProps.index > props.index) {
        moveForward = false;
      }
      const { scene } = moveForward ? props : prevProps;
      const { options } = scene.descriptor;
      if (options && options.transitionConfig) {
        sceneTransitionConfig = options.transitionConfig;
      }
    }
    return {
      timing: Animated.timing,
      duration: 650,
      easing: Easing.inOut(Easing.poly(4)),
      ...this.props.transitionConfig,
      ...sceneTransitionConfig,
      isInteraction: true,
      useNativeDriver: true,
    };
  }

  _reset(position, resetToIndex, duration) {
    Animated.timing(position, {
      toValue: resetToIndex,
      duration,
      easing: Easing.EaseInOut,
      useNativeDriver: position.__isNative,
    }).start();
  }

  _goBack(navigation, position, scenes, backFromIndex, duration) {    
    const toValue = Math.max(backFromIndex - 1, 0);

    // set temporary index for gesture handler to respect until the action is
    // dispatched at the end of the transition.
    this._immediateIndex = toValue;

    Animated.timing(position, {
      toValue,
      duration,
      easing: Easing.EaseInOut,
      useNativeDriver: position.__isNative,
    }).start(() => {
      this._immediateIndex = null;
      const backFromScene = scenes.find(s => s.index === toValue + 1);
      if (!this._isResponding && backFromScene) {
        navigation.dispatch(
          NavigationActions.back({
            key: backFromScene.route.key,
            immediate: true,
          })
        );
      }
    });
  }

  _render(props, prevProps) {
    this._layoutsReady = false;
    
    const { position } = props;    
    const { scene, layout } = props;
    const { navigation } = scene.descriptor;
    
    this._animatedSubscribeForNativeAnimation(props.position);
    this._updateSceneArray(props.scenes);
    
    let toRoute = props.scene.route.routeName;
    let fromRoute = prevProps ? prevProps.scene.route.routeName : null;
    let { index } = props.scene;

    if(!fromRoute) {      
      fromRoute = index > 0 ? props.scenes[index-1].route.routeName : null;
    }

    // If we are just returning to the previous page keep the same props
    if(prevProps && index < prevProps.index && fromRoute === prevProps.scene.route.routeName){
      index = prevProps.index;     
      const tmp = fromRoute;
      fromRoute = toRoute;
      toRoute = tmp;
    }
    
    const handlers = this.getPanResponderHandlers(position, index, 
      scene, layout, navigation, props);

    const scenes = props.scenes.map(scene => this._renderScene({ ...props, scene }));

    return (
      <TransitionItemsView
        {...handlers}
        navigation={this.props.navigation}
        style={this.props.style}
        progress={props.position}
        fromRoute={fromRoute}
        toRoute={toRoute}
        index={index}
        onLayout={this._transitionItemsViewOnLayout}
      >
        {scenes}
      </TransitionItemsView>
    );
  }

  getPanResponderHandlers(position, index, scene, layout, navigation, props) {
    const { mode } = this.props;
    const isVertical = mode !== 'card';
    const { options } = scene.descriptor;
    const gestureDirectionInverted = options.gestureDirection === 'inverted';
    const gesturesEnabled =
      typeof options.gesturesEnabled === 'boolean'
        ? options.gesturesEnabled
        : Platform.OS === 'ios';
    
    // https://github.com/facebook/react-native/issues/8624
    // https://github.com/react-navigation/react-navigation/issues/4144
    if(this._panResponder) {
      const handle = this._panResponder.getInteractionHandle();
      if(handle)
        InteractionManager.clearInteractionHandle(handle);
    }
    this._panResponder = !gesturesEnabled

      ? null
      : PanResponder.create({
        onPanResponderTerminate: () => {
          this._isResponding = false;
          this._reset(position, index, 0);
        },
        onPanResponderGrant: () => {
          position.stopAnimation(value => {
            this._isResponding = true;
            this._gestureStartValue = value;
          });
        },
        onMoveShouldSetPanResponder: (event, gesture) => {
          if (index !== scene.index) {
            return false;
          }
          const immediateIndex = this._immediateIndex == null ? index : this._immediateIndex;
          const currentDragDistance = gesture[isVertical ? 'dy' : 'dx'];
          const currentDragPosition = event.nativeEvent[isVertical ? 'pageY' : 'pageX'];
          const axisLength = isVertical
            ? layout.height.__getValue()
            : layout.width.__getValue(); 
          const axisHasBeenMeasured = !!axisLength;
          // Measure the distance from the touch to the edge of the screen
          // const screenEdgeDistance = gestureDirectionInverted
          //   ? axisLength - (currentDragPosition - currentDragDistance)
          //   : currentDragPosition - currentDragDistance;
          // // Compare to the gesture distance relavant to card or modal
          // const {
          //   gestureResponseDistance: userGestureResponseDistance = {},
          // } = this._getScreenDetails(scene).options;
          // const gestureResponseDistance = isVertical
          //   ? userGestureResponseDistance.vertical ||
          //     GESTURE_RESPONSE_DISTANCE_VERTICAL
          //   : userGestureResponseDistance.horizontal ||
          //     GESTURE_RESPONSE_DISTANCE_HORIZONTAL;
          // // GESTURE_RESPONSE_DISTANCE is about 25 or 30. Or 135 for modals
          // if (screenEdgeDistance > gestureResponseDistance) {
          //   // Reject touches that started in the middle of the screen
          //   return false;
          // }
          const hasDraggedEnough = Math.abs(currentDragDistance) > RESPOND_THRESHOLD;
          const isOnFirstCard = immediateIndex === 0;
          const shouldSetResponder = hasDraggedEnough && axisHasBeenMeasured && !isOnFirstCard;
          return shouldSetResponder;
        },
        onPanResponderMove: (event, gesture) => {
          // Handle the moving touches for our granted responder
          const startValue = this._gestureStartValue;
          const axis = isVertical ? 'dy' : 'dx';
          const axisDistance = isVertical
            ? layout.height.__getValue() * 0.75
            : layout.width.__getValue();
          const currentValue = (I18nManager.isRTL && axis === 'dx') !== gestureDirectionInverted
            ? startValue + gesture[axis] / axisDistance
            : startValue - gesture[axis] / axisDistance;
          const value = clamp(index-1, currentValue, index);          
          position.setValue(value);
        },
        onPanResponderTerminationRequest: () =>
          // Returning false will prevent other views from becoming responder while
          // the navigation view is the responder (mid-gesture)
          false,
        onPanResponderRelease: (event, gesture) => {
          if (!this._isResponding) {
            return;
          }
          this._isResponding = false;
          const immediateIndex = this._immediateIndex == null ? index : this._immediateIndex;
          // Calculate animate duration according to gesture speed and moved distance
          const axisDistance = isVertical
            ? layout.height.__getValue()
            : layout.width.__getValue();
          const movementDirection = gestureDirectionInverted ? -1 : 1;
          const movedDistance = movementDirection * gesture[isVertical ? 'dy' : 'dx'];
          const gestureVelocity = movementDirection * gesture[isVertical ? 'vy' : 'vx'];
          const defaultVelocity = axisDistance / ANIMATION_DURATION;
          const velocity = Math.max(Math.abs(gestureVelocity), defaultVelocity);
          const resetDuration = gestureDirectionInverted
            ? (axisDistance - movedDistance) / velocity
            : movedDistance / velocity;
          const goBackDuration = gestureDirectionInverted
            ? movedDistance / velocity
            : (axisDistance - movedDistance) / velocity;
          // To asyncronously get the current animated value, we need to run stopAnimation:
          position.stopAnimation(value => {
            // If the speed of the gesture release is significant, use that as the indication
            // of intent
            if (gestureVelocity < -0.5) {
              this._reset(position, immediateIndex, resetDuration);
              return;
            }
            if (gestureVelocity > 0.5) {
              this._goBack(navigation, position, props.scenes, immediateIndex, goBackDuration);
              return;
            }
            // Then filter based on the distance the screen was moved. Over a third of the way swiped,
            // and the back will happen.
            if (value <= index - POSITION_THRESHOLD) {
              this._goBack(navigation, position, props.scenes, immediateIndex, goBackDuration);
            }
            else {
              this._reset(position, immediateIndex, resetDuration);
            }
          });
        },
      });
    const handlers = gesturesEnabled ? this._panResponder.panHandlers : {};
    return handlers;
  }

  _renderScene(transitionProps) {
    const { scene } = transitionProps;
    const { index } = scene;
    const { navigation } = scene.descriptor;
    const SceneView = scene.descriptor.getComponent();

    return (
      <TransitionRouteView
        style={[styles.scene, this.getOpacityStyle(transitionProps.position, index)]}
        key={transitionProps.scene.route.key}
        route={scene.route.routeName}
        sceneKey={scene.key}
      >
        <SceneView
          navigation={navigation}
          screenProps={this.props.screenProps}
        />
      </TransitionRouteView>
    );
  }

  getOpacityStyle(position: Animated.Value, index: number) {
    return { opacity: position.interpolate({
      inputRange: [index - 1, index, index + 1],
      outputRange: [0, 1, 0],
    }) };
  }

  _updateSceneArray(scenes: Array<any>) {
    scenes.forEach(scene => {
      if (!this._scenes.find(sri => sri.key === scene.key)) {
        this._scenes = [...this._scenes, { key: scene.key, isMounted: false }];
      }
    });

    const toDelete = [];
    this._scenes.forEach(sri => {
      if (!scenes.find(scene => scene.key === sri.key)) { toDelete.push(sri); }
    });

    toDelete.forEach(sri => {
      const index = this._scenes.indexOf(sri);
      this._scenes = [...this._scenes.slice(0, index), ...this._scenes.slice(index + 1)];
    });
  }

  _getSceneTransitionConfiguration(routeName: string, navigation: any) {
    const route = navigation.state;
    const descriptor = this.props.descriptors;
    const props = { navigation, scene: { route, descriptor } };
    return this._configureTransition(props);
  }
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  scene: {
    position: 'absolute',
    backgroundColor: 'transparent',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  sceneContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});

export default FluidTransitioner;
