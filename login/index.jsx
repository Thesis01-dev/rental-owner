import React, { useState, useEffect } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
} from 'firebase/auth';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { db, auth, storage } from '../../firebase'; // Import storage directly from firebase.js
import Swal from 'sweetalert2';

const Login = ({ auth, firestore }) => {
  // Auth state
  const [activeTab, setActiveTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Additional signup fields
  const [fullName, setFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [address, setAddress] = useState('');
  const [businessPermit, setBusinessPermit] = useState(null);
  const [businessRegistration, setBusinessRegistration] = useState(null);
  const [fileError, setFileError] = useState('');
  const [fileUploading, setFileUploading] = useState(false);

  // Login security
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [isBlocked, setIsBlocked] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const navigate = useNavigate();

  // Initialize login attempts and block status
  useEffect(() => {
    const storedAttempts = localStorage.getItem('loginAttempts');
    const storedBlockEndTime = localStorage.getItem('blockEndTime');

    if (storedAttempts) {
      setLoginAttempts(parseInt(storedAttempts));
    }

    if (storedBlockEndTime) {
      const endTime = parseInt(storedBlockEndTime);
      if (endTime > Date.now()) {
        setIsBlocked(true);
        startCountdown(endTime);
      } else {
        clearBlockStatus();
      }
    }
  }, []);

  const startCountdown = (endTime) => {
    const timer = setInterval(() => {
      const secondsLeft = Math.ceil((endTime - Date.now()) / 1000);

      if (secondsLeft <= 0) {
        clearInterval(timer);
        clearBlockStatus();
      } else {
        setCountdown(secondsLeft);
      }
    }, 1000);

    return () => clearInterval(timer);
  };

  const clearBlockStatus = () => {
    setIsBlocked(false);
    setLoginAttempts(0);
    setCountdown(0);
    localStorage.removeItem('blockEndTime');
    localStorage.setItem('loginAttempts', '0');
  };

  const blockUser = (minutes) => {
    const blockEndTime = Date.now() + (minutes * 60 * 1000);
    setIsBlocked(true);
    localStorage.setItem('blockEndTime', blockEndTime.toString());
    startCountdown(blockEndTime);
  };

  const ensureUserInFirestore = async (user) => {
    try {
      const userDocRef = doc(db, "users", user.uid);
      const userDoc = await getDoc(userDocRef);

      if (!userDoc.exists()) {
        await setDoc(userDocRef, {
          uid: user.uid,
          email: user.email,
          fullName: user.displayName || "New User",
          businessName: user.displayName || "New User",
          registrationDate: serverTimestamp(),
          status: "active",
          role: "owner",
          lastLogin: serverTimestamp(),
          emailVerified: user.emailVerified,
          createdAt: serverTimestamp(),
          profileComplete: true
        });
      } else {
        await setDoc(userDocRef, {
          lastLogin: serverTimestamp(),
          emailVerified: user.emailVerified
        }, { merge: true });
      }
    } catch (error) {
      console.error("Error ensuring user in Firestore:", error);
    }
  };

  const checkUserStatus = async (userId) => {
    try {
      const docRef = doc(db, "users", userId);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        return docSnap.data().status || "pending";
      }
      return "pending";
    } catch (error) {
      console.error("Error checking user status:", error);
      return "pending";
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();

    if (isBlocked) {
      setError(`Account temporarily blocked. Try again in ${formatTime(countdown)}.`);
      return;
    }

    if (!email || !password) {
      setError('Please enter both email and password');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      // CHECK EMAIL VERIFICATION FIRST - This is the key fix
      if (!user.emailVerified) {
        setError('Please verify your email before logging in. Check your inbox for the verification link.');
        setLoading(false);
        return;
      }
      
      await ensureUserInFirestore(user);
      
      const status = await checkUserStatus(user.uid);
      if (status !== "active") {
        throw new Error("Your account is pending approval. Please contact support.");
      }
      
      clearBlockStatus();
      navigate('/dashboard');
    } catch (error) {
      if (error.message.includes("pending approval")) {
        setError(error.message);
        navigate('/pending-approval');
      } else {
        handleLoginError(error);
      }
    } finally {
      setLoading(false);
    }
  };

  // Handles file validation for both business permit and registration
  const handleFileChange = (e, setFile, fileType) => {
    const file = e.target.files[0];
    setFileError('');

    if (file) {
      const validTypes = ['application/pdf', 'image/jpeg', 'image/png'];
      if (!validTypes.includes(file.type)) {
        setFileError(`Please upload a PDF, JPEG, or PNG file for ${fileType}`);
        setFile(null);
        return;
      }
      
      if (file.size > 5 * 1024 * 1024) {
        setFileError(`File size must be less than 5MB for ${fileType}`);
        setFile(null);
        return;
      }
      
      setFile(file);
    }
  };

  const handleBusinessPermitChange = (e) => {
    handleFileChange(e, setBusinessPermit, 'Business Permit');
  };

  const handleBusinessRegistrationChange = (e) => {
    handleFileChange(e, setBusinessRegistration, 'Business Registration');
  };

  // Updated document upload function to use owner_docu/ folder structure
  const uploadDocument = async (userId, file, documentType) => {
    if (!file) return null;
    
    try {
      // Make sure storage is properly imported and available
      if (!storage) {
        throw new Error("Storage is not initialized. Check your firebase.js configuration.");
      }
      
      // Create a file path that stores documents in owner_docu/ folder
      const timestamp = new Date().getTime();
      const sanitizedBusinessName = businessName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const fileExtension = file.name.split('.').pop();
      const fileName = `${sanitizedBusinessName}_${documentType}_${timestamp}.${fileExtension}`;
      
      // Create the storage reference with owner_docu/ path structure
      const storageRef = ref(
        storage, 
        `owner_docu/${userId}/${fileName}`
      );
      
      // Upload the file
      const uploadTask = await uploadBytes(storageRef, file);
      console.log(`${documentType} uploaded successfully to owner_docu/`);
      
      // Get the download URL
      const downloadURL = await getDownloadURL(storageRef);
      
      return {
        url: downloadURL,
        path: storageRef.fullPath,
        fileName: fileName,
        uploadedAt: timestamp,
        fileType: file.type,
        fileSize: file.size,
        documentType: documentType
      };
    } catch (error) {
      console.error(`Error uploading ${documentType}:`, error);
      throw new Error(`Failed to upload ${documentType}: ${error.message}`);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();

    if (!email || !password || !confirmPassword || !fullName || !businessName || !contactNumber || !address || !businessPermit || !businessRegistration) {
      setError('Please fill out all fields and upload all required documents');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    const phoneRegex = /^\+?[0-9]{10,15}$/;
    if (!phoneRegex.test(contactNumber.replace(/\s/g, ''))) {
      setError('Please enter a valid contact number');
      return;
    }

    setLoading(true);
    setError('');
    setFileUploading(true);

    try {
      // 1. Create auth user
      const { user } = await createUserWithEmailAndPassword(auth, email, password);

      // 2. Update profile with display name
      await updateProfile(user, { displayName: businessName });

      // 3. Upload documents to owner_docu/ folder with specific document types
      const permitData = await uploadDocument(user.uid, businessPermit, 'business_permit');
      const registrationData = await uploadDocument(user.uid, businessRegistration, 'business_registration');

      // 4. Create user document in Firestore with emailVerified set to FALSE initially
      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        email: user.email,
        fullName: fullName,
        businessName: businessName,
        contactNumber,
        address,
        businessDocuments: {
          permit: permitData,
          registration: registrationData
        },
        role: "owner",
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp(),
        status: "pending", // Account is pending until admin approval
        emailVerified: false // Initially set to false - will be updated when user verifies
      });

      // 5. Send verification email
      await sendEmailVerification(user);

      // 6. Show success alert with clear instructions
      await Swal.fire({
        title: "Account Created Successfully!",
        html: `
          <p>Your account has been created and is pending admin approval.</p>
          <p><strong>Important:</strong> Please check your email <strong>(${user.email})</strong> and click the verification link before attempting to log in.</p>
          <p>You will not be able to log in until your email is verified.</p>
        `,
        icon: "success",
        confirmButtonText: "Got it!"
      });

      // 7. Switch to login tab
      setActiveTab('login');
      resetForm();
    } catch (error) {
      let errorMessage = 'Failed to create account';

      switch (error.code) {
        case 'auth/email-already-in-use':
          errorMessage = 'Email already in use';
          break;
        case 'auth/invalid-email':
          errorMessage = 'Invalid email address';
          break;
        case 'auth/weak-password':
          errorMessage = 'Password is too weak';
          break;
        default:
          console.error("Signup error:", error);
          errorMessage = 'Error during registration. Please try again.';
      }

      setError(errorMessage);
    } finally {
      setLoading(false);
      setFileUploading(false);
    }
  };

  const handleLoginError = (error) => {
    const newAttempts = loginAttempts + 1;
    setLoginAttempts(newAttempts);
    localStorage.setItem('loginAttempts', newAttempts.toString());

    let errorMessage = 'Invalid email or password';
    let blockDuration = 0;

    switch (newAttempts) {
      case 5:
        blockDuration = 1;
        errorMessage = 'Too many attempts. Blocked for 1 minute.';
        break;
      case 10:
        blockDuration = 5;
        errorMessage = 'Too many attempts. Blocked for 5 minutes.';
        break;
      case 15:
        blockDuration = 15;
        errorMessage = 'Too many attempts. Blocked for 15 minutes.';
        break;
      default:
        errorMessage += ` (Attempt ${newAttempts})`;
    }

    if (blockDuration > 0) {
      blockUser(blockDuration);
    }

    setError(errorMessage);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setFullName('');
    setBusinessName('');
    setContactNumber('');
    setAddress('');
    setBusinessPermit(null);
    setBusinessRegistration(null);
    setError('');
    setFileError('');
  };

  const switchTab = (tab) => {
    setActiveTab(tab);
    resetForm();
  };

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-800">
      {/* Auth Form Section */}
      <div className="w-full md:w-1/2 flex items-center justify-center p-4">
        <div className="w-full max-w-xl bg-gray-800 rounded-lg shadow-md p-8 text-white">
          <div className="flex mb-6">
            <button
              className={`flex-1 py-3 text-center font-medium ${
                activeTab === 'login'
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-300 border-b border-gray-600 hover:text-white'
              }`}
              onClick={() => switchTab('login')}
            >
              Login
            </button>
            <button
              className={`flex-1 py-3 text-center font-medium ${
                activeTab === 'signup'
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-300 border-b border-gray-600 hover:text-white'
              }`}
              onClick={() => switchTab('signup')}
            >
              Sign Up
            </button>
          </div>

          {activeTab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-6">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-white mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <input
                    id="email"
                    type="email"
                    placeholder="example@gmail.com"
                    className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isBlocked || loading}
                  />
                </div>
              </div>
              
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-white mb-1">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isBlocked || loading}
                  />
                </div>
              </div>
              
              {error && (
                <div className="p-3 bg-red-900 border border-red-700 text-white rounded-md text-sm">
                  {error}
                </div>
              )}
              
              {isBlocked ? (
                <div className="p-3 bg-yellow-900 border border-yellow-700 text-white rounded-md text-center">
                  Account temporarily blocked. Try again in {formatTime(countdown)}
                </div>
              ) : (
                <button
                  type="submit"
                  className={`w-full py-3 px-4 rounded-md text-white font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                    loading ? 'bg-blue-700' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                  disabled={loading}
                >
                  {loading ? (
                    <div className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Processing...
                    </div>
                  ) : (
                    'Sign In'
                  )}
                </button>
              )}
              
              <div className="text-center text-sm text-gray-300">
                <a href="#" className="font-medium text-blue-400 hover:text-blue-300">
                  Forgot your password?
                </a>
              </div>
            </form>
          ) : (
            <div className="overflow-y-auto max-h-[70vh] pr-2 -mr-2">
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Email */}
                  <div className="md:col-span-2">
                    <label htmlFor="signup-email" className="block text-sm font-medium text-white mb-1">
                      Email Address <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="signup-email"
                      type="email"
                      placeholder="example@gmail.com"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                  
                  {/* Full Name */}
                  <div className="md:col-span-2">
                    <label htmlFor="full-name" className="block text-sm font-medium text-white mb-1">
                      Full Name <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="full-name"
                      type="text"
                      placeholder="Your Full Name"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                  
                  {/* Business Name */}
                  <div>
                    <label htmlFor="business-name" className="block text-sm font-medium text-white mb-1">
                      Business Name <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="business-name"
                      type="text"
                      placeholder="Your Business Name"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>

                  {/* Contact Number */}
                  <div>
                    <label htmlFor="contact-number" className="block text-sm font-medium text-white mb-1">
                      Contact Number <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="contact-number"
                      type="tel"
                      placeholder="09123456789"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={contactNumber}
                      onChange={(e) => setContactNumber(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                </div>

                {/* Address */}
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-white mb-1">
                    Business Address <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    id="address"
                    placeholder="Enter your business address"
                    className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    disabled={loading}
                    rows="3"
                    required
                  />
                </div>

                {/* Business Permit Upload - Improved */}
                <div>
                  <label htmlFor="business-permit" className="block text-sm font-medium text-white mb-1">
                    Business Permit <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="business-permit"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-500 file:text-white hover:file:bg-blue-600"
                    onChange={handleBusinessPermitChange}
                    disabled={loading}
                    required
                  />
                  <p className="mt-1 text-xs text-gray-300">
                    Upload your business permit (PDF, JPEG, PNG - max 5MB)
                  </p>
                  {businessPermit && (
                    <p className="mt-2 text-sm text-green-300">
                      File selected: {businessPermit.name}
                    </p>
                  )}
                </div>

                {/* Business Registration Upload */}
                <div>
                  <label htmlFor="business-registration" className="block text-sm font-medium text-white mb-1">
                    Business Registration <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="business-registration"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-500 file:text-white hover:file:bg-blue-600"
                    onChange={handleBusinessRegistrationChange}
                    disabled={loading}
                    required
                  />
                  <p className="mt-1 text-xs text-gray-300">
                    Upload your business registration document (PDF, JPEG, PNG - max 5MB)
                  </p>
                  {businessRegistration && (
                    <p className="mt-2 text-sm text-green-300">
                      File selected: {businessRegistration.name}
                    </p>
                  )}
                  {fileError && (
                    <p className="mt-2 text-sm text-red-300">
                      {fileError}
                    </p>
                  )}
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Password */}
                  <div>
                    <label htmlFor="signup-password" className="block text-sm font-medium text-white mb-1">
                      Password <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="signup-password"
                      type="password"
                      placeholder="••••••••"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      required
                      minLength="6"
                    />
                    <p className="mt-1 text-xs text-gray-300">
                      Must be at least 6 characters long
                    </p>
                  </div>

                  {/* Confirm Password */}
                  <div>
                    <label htmlFor="confirm-password" className="block text-sm font-medium text-white mb-1">
                      Confirm Password <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="confirm-password"
                      type="password"
                      placeholder="••••••••"
                      className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-white"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      required
                    />
                  </div>
                </div>
                
                {error && (
                  <div className="p-3 bg-red-900 border border-red-700 text-white rounded-md text-sm">
                    {error}
                  </div>
                )}
                
                <button
                  type="submit"
                  className={`w-full py-3 px-4 rounded-md text-white font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                    loading || fileUploading ? 'bg-blue-700' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                  disabled={loading || fileUploading}
                >
                  {loading ? (
                    <div className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {fileUploading ? 'Uploading Files...' : 'Creating Account...'}
                    </div>
                  ) : (
                    'Register Business'
                  )}
                </button>
                
                <div className="text-center text-sm text-gray-300 pb-2">
                  By signing up, you agree to our{' '}
                  <a href="#" className="font-medium text-blue-400 hover:text-blue-300">
                    Terms
                  </a>{' '}
                  and{' '}
                  <a href="#" className="font-medium text-blue-400 hover:text-blue-300">
                    Privacy Policy
                  </a>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
      
      {/* Welcome Section */}
      <div className="hidden md:flex md:w-1/2 bg-gradient-to-br from-blue-900 to-blue-700 items-center justify-center p-12">
        <div className="text-center text-white max-w-lg">
          <h1 className="text-3xl font-bold mb-6">
            {activeTab === 'login' ? 'Welcome Back!' : 'Register Your Business'}
          </h1>
          <p className="text-xl mb-8">
            {activeTab === 'login'
              ? 'Access your car rental owner dashboard to manage vehicles, bookings, and customers.'
              : 'Create a business account to start managing your car rental business with our powerful tools.'}
          </p>
          <div className="flex justify-center">
            <div className="w-16 h-1 bg-blue-300 rounded-full"></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;