import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyB6eQ-1-LFQTn_6a1dRY6W1IV_IjkqUqcs",
  authDomain: "test-fc608.firebaseapp.com",
  projectId: "test-fc608",
  storageBucket: "test-fc608.firebasestorage.app",
  messagingSenderId: "152500684895",
  appId: "1:152500684895:web:8cf091bb6133f2c33773ea",
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
