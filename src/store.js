import { createStore as create } from './vendor/zustand.js';

// Define the store
export const useStore = create((set) => ({
  // =================================================================
  // STATE
  // All application state lives here.
  // =================================================================

  // Scene state
  currentBackground: null, // Start null so restoration triggers change
  currentMusic: null,
  currentSplash: null,

  // Character state
  characters: {},
  
  // Dialogue and UI state
  dialogueHistory: [], // An array of { character, text } objects
  isAwaitingAIResponse: false,
  
  // Inventory and Object State (NEW)
  inventory: [], // Array of strings, e.g., ["a rusty key", "a half-eaten apple"]
  sceneObjects: [], // Array of strings, e.g., ["a dusty book", "a locked chest"]


  // =================================================================
  // ACTIONS
  // These are functions that safely modify the state.
  // =================================================================

  // Action to change the background
  setBackground: (newBackground) => set({ currentBackground: newBackground }),

  // Action to set the music
  setMusic: (newMusic) => set({ currentMusic: newMusic }),

  // Action to set the splash
  setSplash: (newSplash) => set({ currentSplash: newSplash }),

  // Action to change a character's emotion
  setCharacterEmotion: (characterName, newEmotion) =>
    set((state) => ({
      characters: {
        ...state.characters,
        [characterName]: {
          ...state.characters[characterName],
          emotion: newEmotion,
        },
      },
    })),

  // Action to show/hide a character
  setCharacterVisibility: (characterName, isVisible) =>
    set((state) => ({
      characters: {
        ...state.characters,
        [characterName]: {
          ...state.characters[characterName],
          isVisible: isVisible,
        },
      },
    })),
    
  // Action to add a new line to the dialogue history
  addDialogueLine: (character, text) => 
    set((state) => ({
        dialogueHistory: [...state.dialogueHistory, { character, text }]
    })),

  // Action to set the AI loading state
  setAwaitingAIResponse: (isLoading) => set({ isAwaitingAIResponse: isLoading }),
  
  // Actions for Inventory and Objects (NEW)
  takeObject: (objectName) => 
    set((state) => ({
        inventory: [...state.inventory, objectName],
        sceneObjects: state.sceneObjects.filter(obj => obj !== objectName)
    })),
    
  addObjectToScene: (objectName) =>
    set((state) => ({
        sceneObjects: [...state.sceneObjects, objectName]
    })),

  removeObjectFromScene: (objectName) =>
    set((state) => ({
        sceneObjects: state.sceneObjects.filter(obj => obj !== objectName)
    })),

}));
